import { describe, expect, it } from "vitest";
import {
  getGitHubIssueTaskReadiness,
  getTaskCoordinationClaimState,
  GitHubIssueBacklog,
  formatTaskCoordinationComment,
  hasUnresolvedTaskCoordinationClaim,
  mapGitHubIssueToTask,
  parseTaskCoordinationComment,
} from "./GitHubIssueBacklog.js";

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels?: string[];
  readonly comments: Array<{
    readonly body: string;
    readonly createdAt?: string;
    readonly author?: { readonly login: string };
  }>;
}

const createFakeGh = (issues: FakeIssue[]) => {
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));

  return async (args: string[]): Promise<string> => {
    if (args[0] !== "issue") {
      throw new Error(`Unsupported gh args: ${args.join(" ")}`);
    }

    if (args[1] === "list") {
      return JSON.stringify(
        issues
          .filter((issue) => issue.state === "OPEN")
          .filter((issue) =>
            (issue.labels ?? ["ready-for-agent"]).includes("ready-for-agent"),
          )
          .map((issue) => ({ number: issue.number, title: issue.title })),
      );
    }

    if (args[1] === "view") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) {
        throw new Error(`Unknown issue #${args[2]}`);
      }

      return JSON.stringify(issue);
    }

    if (args[1] === "create") {
      const titleIndex = args.indexOf("--title");
      const bodyIndex = args.indexOf("--body");
      const title = titleIndex >= 0 ? args[titleIndex + 1] : undefined;
      const body = bodyIndex >= 0 ? args[bodyIndex + 1] : undefined;
      const labels: string[] = [];

      for (let index = 2; index < args.length; index += 2) {
        if (args[index] === "--label" && args[index + 1]) {
          labels.push(args[index + 1]!);
        }
      }

      if (!title || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }

      const number = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
      const issue: FakeIssue = {
        number,
        title,
        body,
        state: "OPEN",
        labels,
        comments: [],
      };

      issues.push(issue);
      issuesByNumber.set(number, issue);
      return `https://example.test/issues/${number}\n`;
    }

    if (args[1] === "edit") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) {
        throw new Error(`Unknown issue #${args[2]}`);
      }

      for (let index = 3; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (value === undefined) {
          throw new Error(`Unsupported gh args: ${args.join(" ")}`);
        }

        if (flag === "--body") {
          issue.body = value;
          continue;
        }

        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }

      return "";
    }

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };
};

describe("GitHubIssueBacklog task coordination comments", () => {
  it("formats parseable structured claim, reclaim, release, needs-attention, and done comments", () => {
    const claim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T04:00:00.000Z",
    });
    const reclaim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "reclaim",
      runId: "run-reclaim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:30:00.000Z",
      reason: "The prior claim lease expired before selection.",
      reclaimedClaimRunId: "run-claim",
      reclaimedLeaseExpiresAt: "2026-04-19T04:00:00.000Z",
    });
    const release = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "release",
      runId: "run-release",
      executionMode: "host",
      recordedAt: "2026-04-19T00:01:00.000Z",
      reason: "No landed change.",
    });
    const needsAttention = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "needs-attention",
      runId: "run-needs-attention",
      executionMode: "host",
      recordedAt: "2026-04-19T00:01:30.000Z",
      reason: "Host execution failed and requires intervention.",
    });
    const done = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "done",
      runId: "run-done",
      executionMode: "host",
      recordedAt: "2026-04-19T00:02:00.000Z",
      branch: "main",
      commits: ["abc123"],
    });

    expect(parseTaskCoordinationComment(claim)?.leaseExpiresAt).toBe(
      "2026-04-19T04:00:00.000Z",
    );
    expect(parseTaskCoordinationComment(reclaim)?.event).toBe("reclaim");
    expect(parseTaskCoordinationComment(release)?.event).toBe("release");
    expect(parseTaskCoordinationComment(needsAttention)?.event).toBe(
      "needs-attention",
    );
    expect(needsAttention.toLowerCase()).toContain("needs attention");
    expect(needsAttention).toContain("ordinary retry");
    expect(parseTaskCoordinationComment(done)?.event).toBe("done");
  });

  it("treats an expired claim lease as stale instead of unresolved", () => {
    const claim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T00:30:00.000Z",
    });

    expect(
      getTaskCoordinationClaimState([{ body: claim }], {
        now: new Date("2026-04-19T00:31:00.000Z"),
      }),
    ).toMatchObject({
      status: "stale",
      claim: { runId: "run-claim" },
      leaseExpiresAt: "2026-04-19T00:30:00.000Z",
    });
    expect(
      hasUnresolvedTaskCoordinationClaim([{ body: claim }], {
        now: new Date("2026-04-19T00:31:00.000Z"),
      }),
    ).toBe(false);
  });

  it("treats a release comment as resolving a prior claim", () => {
    const claim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
    });
    const release = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "release",
      runId: "run-release",
      executionMode: "host",
      recordedAt: "2026-04-19T00:01:00.000Z",
    });

    expect(
      hasUnresolvedTaskCoordinationClaim([{ body: claim }, { body: release }]),
    ).toBe(false);
  });

  it("treats a needs-attention comment as resolving a prior claim", () => {
    const claim = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
    });
    const needsAttention = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "needs-attention",
      runId: "run-needs-attention",
      executionMode: "host",
      recordedAt: "2026-04-19T00:01:00.000Z",
      reason: "Manual intervention is required.",
    });

    expect(
      hasUnresolvedTaskCoordinationClaim([
        { body: claim },
        { body: needsAttention },
      ]),
    ).toBe(false);
  });
});

describe("GitHubIssueBacklog.selectNextReadyTask", () => {
  it("maps only explicit Blocked by entries into GitHub-backed Task dependencies", () => {
    const task = mapGitHubIssueToTask({
      number: 7,
      title: "Task with explicit dependencies",
      body: "## Parent\n\n#1\n\n## Blocked by\n\n- Blocked by #3\n- #5\n- Parent PRD is #1 for context only\n- Related note mentioning #5 again should not add a blocker\n",
      state: "OPEN",
      comments: [],
    });

    expect(task).toMatchObject({
      issue: { number: 7 },
      parentIssueNumber: 1,
      dependencies: [
        { issueNumber: 3, relationship: "blocked-by" },
        { issueNumber: 5, relationship: "blocked-by" },
      ],
    });
  });

  it("uses blocked readiness only for unresolved task dependencies", () => {
    const task = mapGitHubIssueToTask({
      number: 7,
      title: "Task with partially resolved dependencies",
      body: "## Blocked by\n\n- Blocked by #3\n- Blocked by #5\n",
      state: "OPEN",
      comments: [],
    });

    expect(
      getGitHubIssueTaskReadiness(
        task,
        new Map([
          [3, "CLOSED"],
          [5, "OPEN"],
        ]),
      ),
    ).toEqual({
      status: "blocked",
      unresolvedDependencies: [{ issueNumber: 5, relationship: "blocked-by" }],
    });
    expect(
      getGitHubIssueTaskReadiness(
        task,
        new Map([
          [3, "CLOSED"],
          [5, "CLOSED"],
        ]),
      ),
    ).toEqual({
      status: "ready",
      unresolvedDependencies: [],
    });
  });

  it("creates a blocking prerequisite issue with lineage, updates Blocked by metadata, and restores readiness after the prerequisite closes", async () => {
    const issues: FakeIssue[] = [
      {
        number: 1,
        title: "PRD: host-first Task Coordination core for GitHub Issues",
        body: "",
        state: "OPEN",
        labels: [],
        comments: [],
      },
      {
        number: 7,
        title: "Current Task that discovered prerequisite work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task after prerequisite work is ready.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh(issues),
    });
    const currentTask = mapGitHubIssueToTask(issues[1]!);

    const blockingPrerequisiteTask =
      await backlog.createBlockingPrerequisiteTask({
        currentTask,
        prerequisite: {
          title: "Add the GitHub Issue body patch helper first",
          body: "## What to build\n\nCreate the issue body patch helper that the current Task now depends on.\n",
        },
      });

    expect(blockingPrerequisiteTask).toMatchObject({
      issue: {
        number: 8,
        title: "Add the GitHub Issue body patch helper first",
        state: "OPEN",
        labels: ["ready-for-agent"],
      },
      parentIssueNumber: 1,
      followOnFromIssueNumber: 7,
      dependencies: [],
    });
    expect(blockingPrerequisiteTask.issue.body).toContain("## Parent\n\n#1");
    expect(blockingPrerequisiteTask.issue.body).toContain(
      "## Follow-on from\n\n- Follow-on from #7",
    );
    expect(issues[1]?.body).toContain("## Blocked by\n\n- Blocked by #8");
    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(8);

    issues[2]!.state = "CLOSED";

    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(7);
  });

  it("creates a proposed follow-on issue with lineage and keeps it out of ready selection until upstream promotion", async () => {
    const issues: FakeIssue[] = [
      {
        number: 1,
        title: "PRD: host-first Task Coordination core for GitHub Issues",
        body: "",
        state: "OPEN",
        labels: [],
        comments: [],
      },
      {
        number: 7,
        title: "Current Task that discovered non-blocking follow-on work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task before curation decides on follow-on work.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh(issues),
    });
    const currentTask = mapGitHubIssueToTask(issues[1]!);

    const proposedFollowOnTask = await backlog.createProposedFollowOnTask({
      currentTask,
      followOn: {
        title: "Document the proposed follow-on promotion flow",
        body: "## What to build\n\nDescribe how Backlog Curation promotes proposed Tasks upstream.\n",
      },
    });

    expect(proposedFollowOnTask).toMatchObject({
      issue: {
        number: 8,
        title: "Document the proposed follow-on promotion flow",
        state: "OPEN",
        labels: [],
      },
      parentIssueNumber: 1,
      followOnFromIssueNumber: 7,
      dependencies: [],
    });
    expect(proposedFollowOnTask.issue.body).toContain("## Parent\n\n#1");
    expect(proposedFollowOnTask.issue.body).toContain(
      "## Follow-on from\n\n- Follow-on from #7",
    );
    expect(issues[1]?.body).not.toContain("## Blocked by");

    issues[1]!.state = "CLOSED";
    expect(await backlog.selectNextReadyTask()).toBeUndefined();

    issues[2]!.labels?.push("ready-for-agent");
    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(8);
  });

  it("skips an open GitHub Issue Task after Task Coordination records done", async () => {
    const doneComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "done",
      runId: "run-done",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      branch: "main",
      commits: ["abc123"],
    });

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 2,
          title: "Landed implementation issue awaiting close retry",
          body: "",
          state: "OPEN",
          comments: [
            {
              body: doneComment,
              createdAt: "2026-04-19T00:01:00.000Z",
              author: { login: "sandcastle" },
            },
          ],
        },
        {
          number: 3,
          title: "Next ready implementation issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask();

    expect(selectedTask?.issue.number).toBe(3);
    expect(selectedTask?.issue.title).toBe("Next ready implementation issue");
  });

  it("selects a stale-claimed GitHub Issue Task again once its lease expires", async () => {
    const staleClaimComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-stale-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T00:30:00.000Z",
    });

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 3,
          title: "Previously claimed implementation issue",
          body: "",
          state: "OPEN",
          comments: [
            {
              body: staleClaimComment,
              createdAt: "2026-04-19T00:00:00.000Z",
              author: { login: "sandcastle" },
            },
          ],
        },
        {
          number: 4,
          title: "Next ready implementation issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask(
      new Date("2026-04-19T00:31:00.000Z"),
    );

    expect(selectedTask?.issue.number).toBe(3);
    expect(selectedTask?.issue.title).toBe(
      "Previously claimed implementation issue",
    );
  });

  it("excludes dependency-blocked tasks from ready selection", async () => {
    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 2,
          title: "Dependency-blocked implementation issue",
          body: "## Blocked by\n\n- Blocked by #99\n",
          state: "OPEN",
          comments: [],
        },
        {
          number: 3,
          title: "Next ready implementation issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
        {
          number: 99,
          title: "Open dependency issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask();

    expect(selectedTask).toMatchObject({
      issue: { number: 3 },
      dependencies: [],
    });
  });

  it("skips Tasks currently labeled needs-attention without reusing dependency-blocked semantics", async () => {
    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 2,
          title: "Execution failure that needs attention",
          body: "",
          state: "OPEN",
          labels: ["ready-for-agent", "needs-attention"],
          comments: [],
        },
        {
          number: 3,
          title: "Dependency-blocked implementation issue",
          body: "## Blocked by\n\n- Blocked by #99\n",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [],
        },
        {
          number: 4,
          title: "Next ready implementation issue",
          body: "",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [],
        },
        {
          number: 99,
          title: "Open dependency issue",
          body: "",
          state: "OPEN",
          labels: [],
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask();

    expect(selectedTask).toMatchObject({
      issue: { number: 4, title: "Next ready implementation issue" },
      dependencies: [],
    });
  });

  it("reselects a GitHub-backed Task after a human restores ready-for-agent", async () => {
    const needsAttentionComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "needs-attention",
      runId: "run-needs-attention",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      reason: "Manual intervention is required to restore host execution.",
    });

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 2,
          title: "Task ready again after human intervention",
          body: "",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [
            {
              body: needsAttentionComment,
              createdAt: "2026-04-19T00:01:00.000Z",
              author: { login: "sandcastle" },
            },
          ],
        },
        {
          number: 3,
          title: "Later ready implementation issue",
          body: "",
          state: "OPEN",
          labels: ["ready-for-agent"],
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask();

    expect(selectedTask).toMatchObject({
      issue: { number: 2, title: "Task ready again after human intervention" },
      dependencies: [],
    });
  });

  it("does not treat incidental issue references inside Blocked by prose as dependency blockers", async () => {
    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 1,
          title: "PRD: host-first Task Coordination core for GitHub Issues",
          body: "",
          state: "OPEN",
          comments: [],
        },
        {
          number: 2,
          title: "Earlier task with incidental PRD reference",
          body: "## Parent\n\n#1\n\n## Blocked by\n\nParent PRD is #1 for context while implementation continues.\n",
          state: "OPEN",
          comments: [],
        },
        {
          number: 3,
          title: "Later ready implementation issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask();

    expect(selectedTask).toMatchObject({
      issue: { number: 2, title: "Earlier task with incidental PRD reference" },
      parentIssueNumber: 1,
      dependencies: [],
    });
  });

  it("restores dependency-aware selection order once dependencies are resolved", async () => {
    const claimedComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claimed",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T04:00:00.000Z",
    });

    const backlog = new GitHubIssueBacklog({
      gh: createFakeGh([
        {
          number: 1,
          title: "PRD: host-first Task Coordination core for GitHub Issues",
          body: "",
          state: "OPEN",
          comments: [],
        },
        {
          number: 2,
          title: "Earlier task with resolved dependency",
          body: "## Parent\n\n#1\n\n## Blocked by\n\n- Blocked by #99\n",
          state: "OPEN",
          comments: [],
        },
        {
          number: 3,
          title: "Claimed implementation issue",
          body: "",
          state: "OPEN",
          comments: [
            {
              body: claimedComment,
              createdAt: "2026-04-19T00:01:00.000Z",
              author: { login: "sandcastle" },
            },
          ],
        },
        {
          number: 4,
          title: "Later ready implementation issue",
          body: "",
          state: "OPEN",
          comments: [],
        },
        {
          number: 99,
          title: "Closed dependency issue",
          body: "",
          state: "CLOSED",
          comments: [],
        },
      ]),
    });

    const selectedTask = await backlog.selectNextReadyTask(
      new Date("2026-04-19T00:31:00.000Z"),
    );

    expect(selectedTask).toMatchObject({
      issue: { number: 2, title: "Earlier task with resolved dependency" },
      parentIssueNumber: 1,
      dependencies: [{ issueNumber: 99, relationship: "blocked-by" }],
    });
  });
});
