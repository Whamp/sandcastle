import { describe, expect, it } from "vitest";
import {
  GitHubImplementationBacklogAdapter,
  READY_FOR_AGENT_LABEL,
  NEEDS_ATTENTION_LABEL,
  formatTaskCoordinationComment,
  parseTaskCoordinationComment,
} from "./GitHubIssueBacklog.js";
import { TaskClaimConflictError } from "./ImplementationCoordination.js";

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  readonly comments: Array<{
    readonly body: string;
    readonly createdAt?: string;
    readonly author?: { readonly login: string };
  }>;
  readonly url?: string;
}

const createFakeGh = (issues: FakeIssue[]) => {
  const commands: string[][] = [];
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  let commentIndex = 0;

  const gh = async (args: string[]): Promise<string> => {
    commands.push(args);

    if (args[0] === "label" && args[1] === "create") {
      return "";
    }

    if (args[0] !== "issue") {
      throw new Error(`Unsupported gh args: ${args.join(" ")}`);
    }

    if (args[1] === "list") {
      const state = args[args.indexOf("--state") + 1];
      const label = args[args.indexOf("--label") + 1];
      return JSON.stringify(
        issues
          .filter((issue) => state !== "open" || issue.state === "OPEN")
          .filter((issue) => !label || issue.labels.includes(label))
          .map((issue) => ({ number: issue.number, title: issue.title })),
      );
    }

    if (args[1] === "view") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) throw new Error(`Unknown issue #${args[2]}`);
      return JSON.stringify(issue);
    }

    if (args[1] === "comment") {
      const issue = issuesByNumber.get(Number(args[2]));
      const body = args[args.indexOf("--body") + 1];
      if (!issue || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }
      commentIndex += 1;
      issue.comments.push({
        body,
        createdAt: `2026-04-19T00:0${commentIndex}:00.000Z`,
        author: { login: "sandcastle" },
      });
      return "";
    }

    if (args[1] === "edit") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) throw new Error(`Unknown issue #${args[2]}`);
      for (let index = 3; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value) throw new Error(`Unsupported gh args: ${args.join(" ")}`);
        if (flag === "--add-label") {
          if (!issue.labels.includes(value)) issue.labels.push(value);
        } else if (flag === "--remove-label") {
          issue.labels = issue.labels.filter((label) => label !== value);
        } else {
          throw new Error(`Unsupported gh args: ${args.join(" ")}`);
        }
      }
      return "";
    }

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };

  return { gh, commands };
};

const makeIssue = (
  issue: Partial<FakeIssue> & Pick<FakeIssue, "number" | "title">,
): FakeIssue => ({
  body: "## Parent\n\n#100\n",
  state: "OPEN",
  labels: [READY_FOR_AGENT_LABEL],
  comments: [],
  ...issue,
});

describe("GitHubImplementationBacklogAdapter", () => {
  it("loads a parent issue and lists only scoped implementation tasks with readiness metadata", async () => {
    const activeClaim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-active",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T04:00:00.000Z",
    });
    const staleClaim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-stale",
      executionMode: "host",
      recordedAt: "2026-04-18T00:00:00.000Z",
      leaseExpiresAt: "2026-04-18T04:00:00.000Z",
    });
    const done = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "done",
      runId: "run-done",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      branch: "task/done",
    });
    const acceptedForIntegration = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "accepted-for-integration",
      runId: "run-accepted",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      branch: "task/accepted",
    });
    const issues: FakeIssue[] = [
      makeIssue({
        number: 100,
        title: "Parent effort",
        body: "parent",
        labels: [],
      }),
      makeIssue({ number: 101, title: "Ready scoped task" }),
      makeIssue({
        number: 102,
        title: "Out of scope",
        body: "## Parent\n\n#999\n",
      }),
      makeIssue({ number: 103, title: "Closed scoped task", state: "CLOSED" }),
      makeIssue({
        number: 104,
        title: "Done scoped task",
        comments: [{ body: done }],
      }),
      makeIssue({
        number: 105,
        title: "Needs attention",
        labels: [READY_FOR_AGENT_LABEL, NEEDS_ATTENTION_LABEL],
      }),
      makeIssue({
        number: 111,
        title: "Accepted scoped task",
        comments: [{ body: acceptedForIntegration }],
      }),
      makeIssue({
        number: 106,
        title: "Active claim",
        comments: [{ body: activeClaim }],
      }),
      makeIssue({
        number: 107,
        title: "Stale claim",
        comments: [{ body: staleClaim }],
      }),
      makeIssue({
        number: 108,
        title: "Blocked task",
        body: "## Parent\n\n#100\n\n## Blocked by\n\n- Blocked by #109\n",
      }),
      makeIssue({ number: 109, title: "Open blocker", labels: [] }),
      makeIssue({ number: 110, title: "Not ready", labels: [] }),
    ];
    const { gh } = createFakeGh(issues);
    const adapter = new GitHubImplementationBacklogAdapter({
      gh,
      now: () => new Date("2026-04-19T00:30:00.000Z"),
      runId: () => "run-current",
    });

    const parent = await adapter.loadParent({
      type: "github-issue",
      issueNumber: 100,
    });
    const scopedTasks = await adapter.listScopedTasks(parent);

    expect(parent).toEqual({ id: "#100", title: "Parent effort" });
    expect(scopedTasks).toEqual([
      { id: "#101", title: "Ready scoped task", blockers: [] },
      { id: "#107", title: "Stale claim", blockers: [] },
      { id: "#108", title: "Blocked task", blockers: ["#109"] },
    ]);
  });

  it("lists explicit issue numbers without using the ready issue list", async () => {
    const issues: FakeIssue[] = [
      makeIssue({ number: 100, title: "Parent effort", labels: [] }),
      makeIssue({ number: 101, title: "Explicit scoped task", labels: [] }),
      makeIssue({ number: 102, title: "Unlisted scoped task" }),
    ];
    const { gh, commands } = createFakeGh(issues);
    const adapter = new GitHubImplementationBacklogAdapter({
      gh,
      issueNumbers: [101],
      now: () => new Date("2026-04-19T00:30:00.000Z"),
    });

    const parent = await adapter.loadParent({
      type: "github-issue",
      issueNumber: 100,
    });
    const scopedTasks = await adapter.listScopedTasks(parent);

    expect(scopedTasks).toEqual([
      { id: "#101", title: "Explicit scoped task", blockers: [] },
    ]);
    expect(commands).not.toContainEqual([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      READY_FOR_AGENT_LABEL,
      "--limit",
      "100",
      "--json",
      "number,title",
    ]);
  });

  it("rejects a final claim attempt when the refreshed issue already has an active claim", async () => {
    const activeClaim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-active",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T04:00:00.000Z",
    });
    const issues: FakeIssue[] = [
      makeIssue({
        number: 101,
        title: "Actively claimed task",
        comments: [{ body: activeClaim }],
      }),
    ];
    const { gh } = createFakeGh(issues);
    const adapter = new GitHubImplementationBacklogAdapter({
      gh,
      now: () => new Date("2026-04-19T00:30:00.000Z"),
      runId: () => "run-current",
    });

    await expect(
      adapter.claimTask({ id: "#101", title: "Actively claimed task" }),
    ).rejects.toBeInstanceOf(TaskClaimConflictError);

    expect(issues[0]!.comments).toHaveLength(1);
  });

  it("records claim, reclaim, release, accepted-for-integration, done, and needs-attention lifecycle comments through fake gh", async () => {
    const staleClaim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-stale",
      executionMode: "host",
      recordedAt: "2026-04-18T00:00:00.000Z",
      leaseExpiresAt: "2026-04-18T04:00:00.000Z",
    });
    const issues: FakeIssue[] = [
      makeIssue({ number: 100, title: "Parent effort", labels: [] }),
      makeIssue({
        number: 101,
        title: "Lifecycle task",
        comments: [{ body: staleClaim }],
      }),
    ];
    const { gh, commands } = createFakeGh(issues);
    const adapter = new GitHubImplementationBacklogAdapter({
      gh,
      now: () => new Date("2026-04-19T00:30:00.000Z"),
      runId: () => "run-current",
    });
    const task = { id: "#101", title: "Lifecycle task" };

    await adapter.claimTask(task);
    await adapter.reclaimTask(task);
    await adapter.releaseTask(task, "worker stopped cleanly");
    await adapter.markTaskAcceptedForIntegration(task, {
      branch: "task/101",
      verification: { passed: true, summary: "typecheck passed" },
    });
    await adapter.markTaskDone(task, {
      branch: "task/101",
      verification: { passed: true, summary: "landed on target" },
    });
    await adapter.markTaskNeedsAttention(task, {
      reason: "worker-failed",
      summary: "manual fix required",
      branch: "task/101",
    });

    const events = issues[1]!.comments
      .map((comment) => parseTaskCoordinationComment(comment.body)?.event)
      .filter(Boolean);
    expect(events).toEqual([
      "claim",
      "reclaim",
      "claim",
      "reclaim",
      "release",
      "accepted-for-integration",
      "done",
      "needs-attention",
    ]);
    expect(issues[1]!.labels).toEqual([NEEDS_ATTENTION_LABEL]);
    expect(commands).toContainEqual([
      "label",
      "create",
      NEEDS_ATTENTION_LABEL,
      "--color",
      "D93F0B",
      "--description",
      expect.any(String),
      "--force",
    ]);
    expect(commands).toContainEqual([
      "issue",
      "edit",
      "101",
      "--add-label",
      NEEDS_ATTENTION_LABEL,
      "--remove-label",
      READY_FOR_AGENT_LABEL,
    ]);
  });
});
