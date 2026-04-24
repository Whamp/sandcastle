import { describe, expect, it } from "vitest";
import {
  coordinateImplementation,
  type CoordinationPullRequest,
  type ImplementationCoordinationOptions,
  type ImplementationCoordinationPorts,
  type ParentEffort,
  type MergeResult,
  type ParentRef,
  type ReviewFinding,
  type ReviewerResult,
  type ScopedTask,
  type TaskWorkspace,
  type VerificationResult,
  TaskClaimConflictError,
  type WorkerResult,
} from "./ImplementationCoordination.js";

const parentRef: ParentRef = { type: "github-issue", issueNumber: 11 };
const parent: ParentEffort = { id: "parent-11", title: "Parent" };
const readyTask: ScopedTask = { id: "task-14", title: "Review-loop outcomes" };
const blockedTask: ScopedTask = {
  id: "task-15",
  title: "Blocked adapter work",
  blockers: ["task-14"],
};

const passedVerification = (
  target: "task" | "coordinator",
): VerificationResult => ({
  target,
  passed: true,
  summary: `${target} verification passed`,
});

class FakePorts {
  readonly events: string[] = [];
  readonly publishedBodies: string[] = [];
  readonly doneOutcomes: unknown[] = [];
  readonly needsAttentionOutcomes: unknown[] = [];
  readonly blockedOutcomes: unknown[] = [];
  readonly taskWorkspaces: TaskWorkspace[] = [];
  scopedTasks: ScopedTask[] = [readyTask];
  workerResults: Array<WorkerResult | Error> = [
    { summary: "implemented task" },
  ];
  reviewerResults: Array<ReviewerResult | unknown | Error> = [{ findings: [] }];
  taskVerifications: Array<VerificationResult | Error> = [
    passedVerification("task"),
  ];
  coordinatorVerification = passedVerification("coordinator");
  mergeResult: MergeResult | Error = { merged: true, summary: "merged" };
  hasIntegratedChanges = true;
  claimError?: Error;
  pushError?: Error;
  publishError?: Error;

  ports(): ImplementationCoordinationPorts {
    return {
      backlog: {
        loadParent: async () => parent,
        listScopedTasks: async () => this.scopedTasks,
        claimTask: async (task) => {
          this.events.push(`backlog:claim:${task.id}`);
          if (this.claimError) {
            throw this.claimError;
          }
        },
        releaseTask: async (task, reason) => {
          this.events.push(`backlog:release:${task.id}:${reason}`);
        },
        markTaskAcceptedForIntegration: async (task, outcome) => {
          this.events.push(`backlog:accepted-for-integration:${task.id}`);
          this.doneOutcomes.push({ task, outcome });
        },
        markTaskBlocked: async (task, outcome) => {
          this.events.push(`backlog:blocked:${task.id}`);
          this.blockedOutcomes.push({ task, outcome });
        },
        markTaskNeedsAttention: async (task, outcome) => {
          this.events.push(`backlog:needs-attention:${task.id}`);
          this.needsAttentionOutcomes.push({ task, outcome });
        },
      },
      workspace: {
        createCoordinatorWorkspace: async () => {
          this.events.push("workspace:create-coordinator");
          return {
            id: "coordinator-workspace",
            path: "/worktrees/coordinator",
            branch: "coordinator/parent-11",
          };
        },
        createTaskWorkspace: async ({ task }) => {
          this.events.push(`workspace:create-task:${task.id}`);
          const workspace = {
            id: `${task.id}-workspace`,
            path: `/worktrees/${task.id}`,
            branch: `task/${task.id}`,
          };
          this.taskWorkspaces.push(workspace);
          return workspace;
        },
        mergeTaskIntoCoordinator: async ({ task }) => {
          this.events.push(`workspace:merge-task:${task.id}`);
          if (this.mergeResult instanceof Error) {
            throw this.mergeResult;
          }
          return this.mergeResult;
        },
        hasIntegratedChanges: async () => {
          this.events.push("workspace:has-integrated-changes");
          return this.hasIntegratedChanges;
        },
        pushCoordinatorBranch: async () => {
          this.events.push("workspace:push-coordinator");
          if (this.pushError) {
            throw this.pushError;
          }
        },
      },
      agentRunner: {
        runWorker: async ({ task, taskWorkspace }) => {
          this.events.push(`agent:worker:${task.id}:${taskWorkspace.branch}`);
          const result = this.workerResults.shift() ?? {
            summary: "fixed task",
          };
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
        runReviewer: async ({ task, taskWorkspace }) => {
          this.events.push(`agent:reviewer:${task.id}:${taskWorkspace.branch}`);
          const result = this.reviewerResults.shift() ?? {
            findings: [],
          };
          if (result instanceof Error) {
            throw result;
          }
          return result as ReviewerResult;
        },
      },
      verifier: {
        verify: async ({ target, task }) => {
          this.events.push(`verify:${target}${task ? `:${task.id}` : ""}`);
          if (target !== "task") {
            return this.coordinatorVerification;
          }
          const result =
            this.taskVerifications.shift() ?? passedVerification("task");
          if (result instanceof Error) {
            throw result;
          }
          return result;
        },
      },
      pullRequests: {
        createOrUpdate: async (options): Promise<CoordinationPullRequest> => {
          this.events.push("pull-request:publish");
          if (this.publishError) {
            throw this.publishError;
          }
          this.publishedBodies.push(options.body);
          return {
            id: "pr-14",
            url: "https://example.test/pr/14",
            body: options.body,
          };
        },
      },
    };
  }

  run(options: Partial<ImplementationCoordinationOptions> = {}) {
    return coordinateImplementation({
      parent: parentRef,
      ports: this.ports(),
      ...options,
      policy: { maxReviewRounds: 2, ...options.policy },
    });
  }
}

describe("coordinateImplementation", () => {
  it("loads a parent effort, reports no completed tasks, and does not publish a PR when no scoped tasks exist", async () => {
    const fake = new FakePorts();
    fake.scopedTasks = [];

    const result = await fake.run();

    expect(result.parent).toBe(parent);
    expect(result.scopedTasks).toEqual([]);
    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.pullRequest).toBeUndefined();
    expect(result.noPullRequestReason).toContain(
      "no issue branch was accepted",
    );
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
    expect(fake.events).toEqual([]);
  });

  it("does not run worker or publish PR for non-empty scoped tasks when lifecycle methods are absent", async () => {
    const events: string[] = [];

    await expect(
      coordinateImplementation({
        parent: parentRef,
        ports: {
          backlog: {
            async loadParent() {
              events.push("backlog:load-parent");
              return parent;
            },
            async listScopedTasks() {
              events.push("backlog:list-scoped-tasks");
              return [readyTask];
            },
          },
          pullRequests: {
            async createOrUpdate() {
              events.push("pull-request:publish");
              return { url: "https://example.test/pr/13" };
            },
          },
        },
      }),
    ).rejects.toThrow(
      "backlog lifecycle methods claimTask, releaseTask, markTaskAcceptedForIntegration, markTaskBlocked, and markTaskNeedsAttention are required when scoped tasks exist",
    );

    expect(events).toEqual([
      "backlog:load-parent",
      "backlog:list-scoped-tasks",
    ]);
  });

  it("reruns a worker on the same task workspace after P0/P1 reviewer findings and accepts a later clean review", async () => {
    const fake = new FakePorts();
    fake.workerResults = [
      { summary: "first implementation" },
      { summary: "fixed blocking finding" },
    ];
    fake.reviewerResults = [
      { findings: [{ severity: "P1", title: "Blocking bug" }] },
      { findings: [] },
    ];

    const result = await fake.run();

    expect(fake.taskWorkspaces).toHaveLength(1);
    expect(fake.events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim:task-14",
      "workspace:create-task:task-14",
      "agent:worker:task-14:task/task-14",
      "agent:reviewer:task-14:task/task-14",
      "agent:worker:task-14:task/task-14",
      "agent:reviewer:task-14:task/task-14",
      "verify:task:task-14",
      "workspace:merge-task:task-14",
      "verify:coordinator",
      "workspace:has-integrated-changes",
      "workspace:push-coordinator",
      "pull-request:publish",
      "backlog:accepted-for-integration:task-14",
    ]);
    expect(result.acceptedForIntegrationTasks).toHaveLength(1);
    expect(result.needsAttentionTasks).toEqual([]);
    expect(result.mergeRecommendation).toBe("recommend-merge");
  });

  it("does not mark a task accepted for integration when pushing the coordinator branch fails", async () => {
    const fake = new FakePorts();
    fake.pushError = new Error("push failed");

    await expect(fake.run()).rejects.toThrow("push failed");

    expect(fake.events).toContain("workspace:push-coordinator");
    expect(fake.events).not.toContain(
      "backlog:accepted-for-integration:task-14",
    );
  });

  it("does not mark a task accepted for integration when publishing the coordination PR fails", async () => {
    const fake = new FakePorts();
    fake.publishError = new Error("PR failed");

    await expect(fake.run()).rejects.toThrow("PR failed");

    expect(fake.events).toContain("pull-request:publish");
    expect(fake.events).not.toContain(
      "backlog:accepted-for-integration:task-14",
    );
  });

  it("skips a task when the refreshed claim has already been taken", async () => {
    const fake = new FakePorts();
    fake.claimError = new TaskClaimConflictError("already claimed");

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks).toEqual([]);
    expect(fake.events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim:task-14",
    ]);
  });

  it("records P2/P3 reviewer findings in the result and PR body without blocking acceptance", async () => {
    const fake = new FakePorts();
    fake.reviewerResults = [
      {
        findings: [
          {
            severity: "P2",
            title: "Improve edge-case test",
            body: "Add a compact test.",
          },
          { severity: "P3", title: "Clarify comment" },
        ],
      },
    ];

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks[0]?.reviewFindings).toEqual([
      {
        severity: "P2",
        title: "Improve edge-case test",
        body: "Add a compact test.",
      },
      { severity: "P3", title: "Clarify comment" },
    ]);
    expect(result.nonBlockingReviewFindings).toHaveLength(2);
    expect(result.needsAttentionTasks).toEqual([]);
    expect(fake.publishedBodies[0]).toContain("Improve edge-case test");
    expect(fake.publishedBodies[0]).toContain("Clarify comment");
    expect(result.mergeRecommendation).toBe("recommend-merge");
  });

  it("does not leak P2/P3 findings from tasks that fail before acceptance", async () => {
    const laterTask: ScopedTask = { id: "task-16", title: "Later task" };
    const fake = new FakePorts();
    fake.scopedTasks = [readyTask, laterTask];
    fake.reviewerResults = [
      { findings: [{ severity: "P2", title: "Failed task note" }] },
      { findings: [{ severity: "P2", title: "Accepted task note" }] },
    ];
    fake.taskVerifications = [
      { target: "task", passed: false, summary: "first task failed" },
      passedVerification("task"),
    ];

    const result = await fake.run();

    expect(
      result.acceptedForIntegrationTasks.map((task) => task.task.id),
    ).toEqual(["task-16"]);
    expect(result.needsAttentionTasks.map((task) => task.task.id)).toEqual([
      "task-14",
    ]);
    expect(result.nonBlockingReviewFindings).toEqual([
      { severity: "P2", title: "Accepted task note" },
    ]);
    expect(fake.publishedBodies[0]).not.toContain("Failed task note");
    expect(fake.publishedBodies[0]).toContain("Accepted task note");
  });

  it("marks a task needs-attention with unresolved findings when max review rounds are exhausted", async () => {
    const fake = new FakePorts();
    fake.reviewerResults = [
      { findings: [{ severity: "P0", title: "Data loss" }] },
      { findings: [{ severity: "P1", title: "Still broken" }] },
    ];

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks).toHaveLength(1);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      task: readyTask,
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
      reason: "max-review-rounds-exhausted",
      findings: [{ severity: "P1", title: "Still broken" }],
    });
    expect(fake.needsAttentionOutcomes).toHaveLength(1);
    expect(result.pullRequest).toBeUndefined();
    expect(result.noPullRequestReason).toContain(
      "no issue branch was accepted",
    );
  });

  it("reports blocked scoped tasks with blockers and does not claim them", async () => {
    const fake = new FakePorts();
    fake.scopedTasks = [blockedTask];

    const result = await fake.run();

    expect(result.blockedTasks).toEqual([
      { task: blockedTask, blockers: ["task-14"] },
    ]);
    expect(fake.events).toEqual([
      "workspace:create-coordinator",
      "backlog:blocked:task-15",
    ]);
    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.pullRequest).toBeUndefined();
  });

  it("marks worker failure needs-attention and preserves branch/workspace details when available", async () => {
    const fake = new FakePorts();
    fake.workerResults = [new Error("worker crashed")];

    const result = await fake.run();

    expect(result.needsAttentionTasks[0]).toMatchObject({
      task: readyTask,
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
      reason: "worker-failed",
      summary: "worker crashed",
    });
    expect(result.pullRequest).toBeUndefined();
  });

  it("marks unparseable reviewer output needs-attention instead of accepting the task", async () => {
    const fake = new FakePorts();
    fake.reviewerResults = [{ findings: [{ severity: "P5", title: "bad" }] }];

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      reason: "reviewer-output-unparseable",
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
    });
    expect(fake.events).not.toContain("verify:task:task-14");
    expect(result.pullRequest).toBeUndefined();
  });

  it("marks reviewer adapter throws as unparseable reviewer output and releases the task", async () => {
    const fake = new FakePorts();
    fake.reviewerResults = [new Error("Unexpected token < in JSON")];

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      task: readyTask,
      reason: "reviewer-output-unparseable",
      summary: "Unexpected token < in JSON",
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
    });
    expect(fake.needsAttentionOutcomes[0]).toMatchObject({
      task: readyTask,
      outcome: {
        reason: "reviewer-output-unparseable",
        summary: "Unexpected token < in JSON",
        branch: "task/task-14",
        workspace: "/worktrees/task-14",
      },
    });
    expect(fake.events).toContain(
      "backlog:release:task-14:reviewer-output-unparseable",
    );
    expect(fake.events).not.toContain("verify:task:task-14");
    expect(result.pullRequest).toBeUndefined();
  });

  it("rejects invalid max review rounds before claiming a task", async () => {
    const fake = new FakePorts();

    await expect(fake.run({ policy: { maxReviewRounds: 0 } })).rejects.toThrow(
      "policy.maxReviewRounds must be a positive integer",
    );

    expect(fake.events).toEqual([]);
  });

  it.each([
    {
      name: "task verification failure",
      configure(fake: FakePorts) {
        fake.taskVerifications = [
          { target: "task", passed: false, summary: "task tests failed" },
        ];
      },
      reason: "task-verification-failed",
      summary: "task tests failed",
    },
    {
      name: "merge failure",
      configure(fake: FakePorts) {
        fake.mergeResult = { merged: false, summary: "merge conflict" };
      },
      reason: "merge-failed",
      summary: "merge conflict",
    },
  ])("marks $name needs-attention", async ({ configure, reason, summary }) => {
    const fake = new FakePorts();
    configure(fake);

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      reason,
      summary,
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
    });
    expect(result.pullRequest).toBeUndefined();
    expect(fake.events).not.toContain(
      "backlog:accepted-for-integration:task-14",
    );
  });

  it("marks task verifier rejection needs-attention and releases the claim", async () => {
    const fake = new FakePorts();
    fake.taskVerifications = [new Error("task verification command crashed")];

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      task: readyTask,
      reason: "task-verification-failed",
      summary: "task verification command crashed",
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
    });
    expect(fake.needsAttentionOutcomes[0]).toMatchObject({
      task: readyTask,
      outcome: {
        reason: "task-verification-failed",
        summary: "task verification command crashed",
        branch: "task/task-14",
        workspace: "/worktrees/task-14",
      },
    });
    expect(fake.events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim:task-14",
      "workspace:create-task:task-14",
      "agent:worker:task-14:task/task-14",
      "agent:reviewer:task-14:task/task-14",
      "verify:task:task-14",
      "backlog:needs-attention:task-14",
      "backlog:release:task-14:task-verification-failed",
    ]);
    expect(fake.events).not.toContain(
      "backlog:accepted-for-integration:task-14",
    );
    expect(fake.events).not.toContain("workspace:merge-task:task-14");
    expect(fake.events).not.toContain("pull-request:publish");
    expect(result.pullRequest).toBeUndefined();
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
  });

  it("marks merge adapter rejection needs-attention and releases the claim", async () => {
    const fake = new FakePorts();
    fake.mergeResult = new Error("merge driver crashed");

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.needsAttentionTasks[0]).toMatchObject({
      task: readyTask,
      reason: "merge-failed",
      summary: "merge driver crashed",
      branch: "task/task-14",
      workspace: "/worktrees/task-14",
    });
    expect(fake.needsAttentionOutcomes[0]).toMatchObject({
      task: readyTask,
      outcome: {
        reason: "merge-failed",
        summary: "merge driver crashed",
        branch: "task/task-14",
        workspace: "/worktrees/task-14",
      },
    });
    expect(fake.events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim:task-14",
      "workspace:create-task:task-14",
      "agent:worker:task-14:task/task-14",
      "agent:reviewer:task-14:task/task-14",
      "verify:task:task-14",
      "workspace:merge-task:task-14",
      "backlog:needs-attention:task-14",
      "backlog:release:task-14:merge-failed",
    ]);
    expect(fake.events).not.toContain(
      "backlog:accepted-for-integration:task-14",
    );
    expect(fake.events).not.toContain("verify:coordinator");
    expect(fake.events).not.toContain("pull-request:publish");
    expect(result.pullRequest).toBeUndefined();
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
  });

  it("continues to later unblocked tasks after an earlier needs-attention task but does not recommend merge", async () => {
    const fake = new FakePorts();
    const secondTask: ScopedTask = { id: "task-16", title: "Safe follow-up" };
    fake.scopedTasks = [readyTask, secondTask];
    fake.workerResults = [
      new Error("first failed"),
      { summary: "second implemented" },
    ];
    fake.reviewerResults = [{ findings: [] }];

    const result = await fake.run();

    expect(result.needsAttentionTasks).toHaveLength(1);
    expect(
      result.acceptedForIntegrationTasks.map((task) => task.task.id),
    ).toEqual(["task-16"]);
    expect(result.pullRequest?.url).toBe("https://example.test/pr/14");
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
    expect(fake.publishedBodies[0]).toContain("**Do not recommend merge yet**");
  });

  it("does not publish a PR or recommend merge when accepted tasks produce no integrated changes", async () => {
    const fake = new FakePorts();
    fake.hasIntegratedChanges = false;

    const result = await fake.run();

    expect(result.acceptedForIntegrationTasks).toEqual([]);
    expect(result.pullRequest).toBeUndefined();
    expect(result.noPullRequestReason).toContain("no integrated changes");
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
    expect(fake.events).not.toContain("workspace:push-coordinator");
    expect(fake.events).not.toContain("pull-request:publish");
  });
});
