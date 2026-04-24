import { describe, expect, it } from "vitest";
import {
  runIntegrationFinalization,
  type IntegrationFinalizationCoordinationPullRequest,
  type IntegrationFinalizationOptions,
  type IntegrationFinalizationPorts,
} from "./IntegrationFinalization.js";

const acceptedTask = {
  id: "#23",
  issueNumber: 23,
  title: "Add ports-first Integration Finalization core",
  branch: "sandcastle/task/23-finalization-core",
};

const secondAcceptedTask = {
  id: "#24",
  issueNumber: 24,
  title: "Add finalization adapters",
  branch: "sandcastle/task/24-finalization-adapters",
};

const manifestBody = (
  acceptedTasks: readonly (typeof acceptedTask)[] = [acceptedTask],
) =>
  [
    "<!-- sandcastle:coordination-manifest:start -->",
    "```json",
    JSON.stringify({
      kind: "sandcastle.coordination-manifest",
      version: 1,
      parentScope: { id: "#21", issueNumber: 21, title: "Parent PRD" },
      coordinatorBranch: "sandcastle/coordinator/21",
      targetBranch: "main",
      baseBranch: "main",
      acceptedTasks,
      publication: {
        publisher: "sandcastle",
        publishedAt: "2026-04-24T10:00:00.000Z",
        mergeRecommendation: "recommend-merge",
        acceptedTaskCount: acceptedTasks.length,
      },
    }),
    "```",
    "<!-- sandcastle:coordination-manifest:end -->",
  ].join("\n");

class FakeFinalizationPorts {
  readonly events: string[] = [];
  readonly doneOutcomes: unknown[] = [];
  readonly reports: unknown[] = [];
  pullRequest: IntegrationFinalizationCoordinationPullRequest = {
    id: "pr-21",
    number: 21,
    url: "https://example.test/pull/21",
    state: "open",
    merged: false,
    body: manifestBody(),
  };
  landingProofResult = { passed: true, summary: "landed" };
  taskStates = new Map<string, "accepted-for-integration" | "done" | "other">();

  ports(): IntegrationFinalizationPorts {
    return {
      coordinationPullRequests: {
        load: async (ref) => {
          this.events.push(`pr:load:${ref.id ?? ref.url ?? ref.number}`);
          return this.pullRequest;
        },
      },
      landingProof: {
        prove: async ({ targetBranch, landedCommit }) => {
          this.events.push(`proof:${targetBranch}:${landedCommit}`);
          return this.landingProofResult;
        },
      },
      backlog: {
        loadTaskState: async (task) => {
          this.events.push(`backlog:load:${task.id}`);
          return {
            state: this.taskStates.get(task.id) ?? "accepted-for-integration",
          };
        },
        markTaskDone: async (task, outcome) => {
          this.events.push(`backlog:done:${task.id}`);
          this.doneOutcomes.push({ task, outcome });
        },
      },
      reporter: {
        report: async (report) => {
          this.events.push(`report:${report.outcome}`);
          this.reports.push(report);
        },
      },
    };
  }

  run(options: Partial<IntegrationFinalizationOptions> = {}) {
    return runIntegrationFinalization({
      coordinationPullRequest: { id: "pr-21" },
      ports: this.ports(),
      ...options,
    });
  }
}

describe("runIntegrationFinalization", () => {
  it("returns pending and mutates no child tasks when the coordination PR is open", async () => {
    const fake = new FakeFinalizationPorts();

    const result = await fake.run();

    expect(result.outcome).toBe("pending");
    expect(result.reason).toBe("coordination-pr-open");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.events).toEqual(["pr:load:pr-21", "report:pending"]);
    expect(fake.reports).toEqual([
      {
        outcome: "pending",
        reason: "coordination-pr-open",
        summary:
          "Integration Finalization is pending because the coordination PR is still open.",
        coordinationPullRequest: {
          id: "pr-21",
          number: 21,
          url: "https://example.test/pull/21",
        },
        targetBranch: "main",
        acceptedTasks: [acceptedTask],
        finalizedTasks: [],
      },
    ]);
  });

  it("records finalization needs attention and mutates no child tasks when the coordination PR is closed unmerged", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: false,
    };

    const result = await fake.run();

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("coordination-pr-closed-unmerged");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "report:finalization-needs-attention",
    ]);
  });

  it.each([
    [
      "coordination-manifest-missing" as const,
      "Human-only coordination PR body",
    ],
    [
      "coordination-manifest-invalid" as const,
      [
        "<!-- sandcastle:coordination-manifest:start -->",
        "```json",
        "{not-json}",
        "```",
        "<!-- sandcastle:coordination-manifest:end -->",
      ].join("\n"),
    ],
  ])(
    "records finalization needs attention and mutates no child tasks when the manifest is %s",
    async (reason, body) => {
      const fake = new FakeFinalizationPorts();
      fake.pullRequest = {
        ...fake.pullRequest,
        state: "closed",
        merged: true,
        landedCommit: "abc123",
        body,
      };

      const result = await fake.run();

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe(reason);
      expect(result.finalizedTasks).toEqual([]);
      expect(fake.events).toEqual([
        "pr:load:pr-21",
        "report:finalization-needs-attention",
      ]);
    },
  );

  it("records finalization needs attention and mutates no child tasks when target-branch landing proof fails", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: true,
      landedCommit: "abc123",
    };
    fake.landingProofResult = {
      passed: false,
      summary: "abc123 is not an ancestor of main",
    };

    const result = await fake.run();

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("target-branch-landing-proof-failed");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "proof:main:abc123",
      "report:finalization-needs-attention",
    ]);
    expect(fake.reports).toEqual([
      {
        outcome: "finalization-needs-attention",
        reason: "target-branch-landing-proof-failed",
        summary: "abc123 is not an ancestor of main",
        coordinationPullRequest: {
          id: "pr-21",
          number: 21,
          url: "https://example.test/pull/21",
        },
        targetBranch: "main",
        landedCommit: "abc123",
        acceptedTasks: [acceptedTask],
        finalizedTasks: [],
      },
    ]);
  });

  it("records landing proof failure and mutates no child tasks when a merged coordination PR has no landed commit", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: true,
    };

    const result = await fake.run();

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("target-branch-landing-proof-failed");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.doneOutcomes).toEqual([]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "report:finalization-needs-attention",
    ]);
    expect(fake.reports).toEqual([
      {
        outcome: "finalization-needs-attention",
        reason: "target-branch-landing-proof-failed",
        summary:
          "Integration Finalization needs attention because the merged coordination PR did not provide a landed commit to prove on the target branch.",
        coordinationPullRequest: {
          id: "pr-21",
          number: 21,
          url: "https://example.test/pull/21",
        },
        targetBranch: "main",
        acceptedTasks: [acceptedTask],
        finalizedTasks: [],
      },
    ]);
  });

  it("records finalization needs attention and mutates no child tasks when the coordination PR base branch does not match the manifest target branch", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: true,
      landedCommit: "abc123",
      baseBranch: "release",
    };

    const result = await fake.run();

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("coordination-pr-target-branch-mismatch");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.doneOutcomes).toEqual([]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "report:finalization-needs-attention",
    ]);
    expect(fake.reports).toEqual([
      {
        outcome: "finalization-needs-attention",
        reason: "coordination-pr-target-branch-mismatch",
        summary:
          "Integration Finalization needs attention because the coordination PR base branch release does not match the manifest target branch main.",
        coordinationPullRequest: {
          id: "pr-21",
          number: 21,
          url: "https://example.test/pull/21",
        },
        targetBranch: "main",
        landedCommit: "abc123",
        acceptedTasks: [acceptedTask],
        finalizedTasks: [],
      },
    ]);
  });

  it("records finalization needs attention and mutates no child tasks when an accepted child task state is inconsistent", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: true,
      landedCommit: "abc123",
      body: manifestBody([acceptedTask, secondAcceptedTask]),
    };
    fake.taskStates.set("#24", "other");

    const result = await fake.run();

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("accepted-task-state-inconsistent");
    expect(result.finalizedTasks).toEqual([]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "proof:main:abc123",
      "backlog:load:#23",
      "backlog:load:#24",
      "report:finalization-needs-attention",
    ]);
  });

  it("finalizes the whole manifest accepted task set as one atomic decision after successful target-branch landing proof", async () => {
    const fake = new FakeFinalizationPorts();
    fake.pullRequest = {
      ...fake.pullRequest,
      state: "closed",
      merged: true,
      landedCommit: "abc123",
      body: manifestBody([acceptedTask, secondAcceptedTask]),
    };

    const result = await fake.run();

    expect(result.outcome).toBe("finalized");
    expect(result.reason).toBe("finalized");
    expect(result.finalizedTasks.map((task) => task.id)).toEqual([
      "#23",
      "#24",
    ]);
    expect(result.decision).toEqual({
      kind: "atomic-finalization",
      targetBranch: "main",
      landedCommit: "abc123",
      acceptedTasks: [acceptedTask, secondAcceptedTask],
    });
    expect(fake.doneOutcomes).toEqual([
      {
        task: acceptedTask,
        outcome: {
          branch: "sandcastle/task/23-finalization-core",
          targetBranch: "main",
          landedCommit: "abc123",
          summary: "Accepted task landed on main at abc123.",
        },
      },
      {
        task: secondAcceptedTask,
        outcome: {
          branch: "sandcastle/task/24-finalization-adapters",
          targetBranch: "main",
          landedCommit: "abc123",
          summary: "Accepted task landed on main at abc123.",
        },
      },
    ]);
    expect(fake.events).toEqual([
      "pr:load:pr-21",
      "proof:main:abc123",
      "backlog:load:#23",
      "backlog:load:#24",
      "backlog:done:#23",
      "backlog:done:#24",
      "report:finalized",
    ]);
    expect(fake.reports).toEqual([
      {
        outcome: "finalized",
        reason: "finalized",
        summary:
          "Integration Finalization marked 2 accepted for integration task(s) done after proving abc123 landed on main.",
        coordinationPullRequest: {
          id: "pr-21",
          number: 21,
          url: "https://example.test/pull/21",
        },
        targetBranch: "main",
        landedCommit: "abc123",
        acceptedTasks: [acceptedTask, secondAcceptedTask],
        finalizedTasks: [acceptedTask, secondAcceptedTask],
      },
    ]);
  });
});
