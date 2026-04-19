import { describe, expect, it } from "vitest";
import {
  GitHubIssueBacklog,
  formatTaskCoordinationComment,
  hasUnresolvedTaskCoordinationClaim,
  parseTaskCoordinationComment,
} from "./GitHubIssueBacklog.js";

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
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

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };
};

describe("GitHubIssueBacklog task coordination comments", () => {
  it("formats parseable structured claim, release, and done comments", () => {
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
      reason: "No landed change.",
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

    expect(parseTaskCoordinationComment(claim)?.event).toBe("claim");
    expect(parseTaskCoordinationComment(release)?.event).toBe("release");
    expect(parseTaskCoordinationComment(done)?.event).toBe("done");
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
});

describe("GitHubIssueBacklog.selectNextReadyTask", () => {
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

  it("selects the lowest-number ready GitHub Issue task and skips PRDs, blocked issues, and unresolved claims", async () => {
    const claimedComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-claimed",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
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
          title: "Blocked implementation issue",
          body: "## Blocked by\n\n- Blocked by #99\n",
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
          title: "Ready implementation issue",
          body: "## Parent\n\n#1\n",
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

    expect(selectedTask?.issue.number).toBe(4);
    expect(selectedTask?.issue.title).toBe("Ready implementation issue");
    expect(selectedTask?.parentIssueNumber).toBe(1);
  });
});
