import { describe, expect, it } from "vitest";
import {
  coordinateImplementation,
  type CoordinationPullRequest,
  type ImplementationCoordinationPullRequestPort,
  type ParentEffort,
  type ParentRef,
  type ScopedTask,
} from "./ImplementationCoordination.js";

describe("coordinateImplementation", () => {
  it("loads a parent effort, reports no completed tasks, and does not publish a PR when no scoped tasks exist", async () => {
    const parentRef: ParentRef = { type: "github-issue", issueNumber: 11 };
    const parent: ParentEffort = {
      id: "parent-11",
      title: "Parent scoped implementation effort",
    };
    const scopedTasks: ScopedTask[] = [];
    const publishedPullRequests: unknown[] = [];
    const pullRequests: ImplementationCoordinationPullRequestPort = {
      async createOrUpdate(options): Promise<CoordinationPullRequest> {
        publishedPullRequests.push(options);
        return { url: "https://example.test/pr/1" };
      },
    };

    const result = await coordinateImplementation({
      parent: parentRef,
      ports: {
        backlog: {
          async loadParent(ref) {
            expect(ref).toEqual(parentRef);
            return parent;
          },
          async listScopedTasks(loadedParent) {
            expect(loadedParent).toBe(parent);
            return scopedTasks;
          },
        },
        pullRequests,
      },
    });

    expect(result.parent).toBe(parent);
    expect(result.scopedTasks).toEqual([]);
    expect(result.completedTasks).toEqual([]);
    expect(result.pullRequest).toBeUndefined();
    expect(result.noPullRequestReason).toContain(
      "no issue branch was accepted",
    );
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
    expect(publishedPullRequests).toEqual([]);
  });

  it("does not run worker or publish PR for non-empty scoped tasks when lifecycle methods are absent", async () => {
    const events: string[] = [];
    const parent: ParentEffort = { id: "parent-11", title: "Parent" };
    const task: ScopedTask = { id: "task-13", title: "One accepted task" };

    await expect(
      coordinateImplementation({
        parent: { type: "github-issue", issueNumber: 11 },
        ports: {
          backlog: {
            async loadParent() {
              events.push("backlog:load-parent");
              return parent;
            },
            async listScopedTasks() {
              events.push("backlog:list-scoped-tasks");
              return [task];
            },
          },
          workspace: {
            async createCoordinatorWorkspace() {
              events.push("workspace:create-coordinator");
              return {
                path: "/worktrees/coordinator",
                branch: "coordinator/parent-11",
              };
            },
            async createTaskWorkspace() {
              events.push("workspace:create-task");
              return {
                path: "/worktrees/task-13",
                branch: "task/13-one-accepted-task",
              };
            },
            async mergeTaskIntoCoordinator() {
              events.push("workspace:merge-task");
              return { merged: true };
            },
            async hasIntegratedChanges() {
              events.push("workspace:has-integrated-changes");
              return true;
            },
            async pushCoordinatorBranch() {
              events.push("workspace:push-coordinator");
            },
          },
          agentRunner: {
            async runWorker() {
              events.push("agent:worker");
              return { summary: "Implemented task 13" };
            },
            async runReviewer() {
              events.push("agent:reviewer");
              return { findings: [] };
            },
          },
          verifier: {
            async verify(options) {
              events.push(`verify:${options.target}`);
              return {
                target: options.target,
                passed: true,
                summary: `${options.target} verification passed`,
              };
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
      "backlog lifecycle methods claimTask and markTaskDone are required when scoped tasks exist",
    );

    expect(events).toEqual([
      "backlog:load-parent",
      "backlog:list-scoped-tasks",
    ]);
  });

  it.each([
    {
      name: "failed task verification",
      taskVerification: { passed: false, summary: "task tests failed" },
      mergeResult: { merged: true },
      expectedError: "Task verification failed for task-13: task tests failed",
      forbiddenEvents: [
        "workspace:merge-task",
        "backlog:done",
        "pull-request:publish",
      ],
    },
    {
      name: "merge failure",
      taskVerification: { passed: true, summary: "task tests passed" },
      mergeResult: { merged: false, summary: "merge conflict" },
      expectedError: "Merge failed for task-13: merge conflict",
      forbiddenEvents: ["backlog:done", "pull-request:publish"],
    },
  ])(
    "does not mark done, publish, or recommend merge after $name",
    async ({ taskVerification, mergeResult, expectedError, forbiddenEvents }) => {
      const events: string[] = [];
      const parent: ParentEffort = { id: "parent-11", title: "Parent" };
      const task: ScopedTask = { id: "task-13", title: "One accepted task" };

      await expect(
        coordinateImplementation({
          parent: { type: "github-issue", issueNumber: 11 },
          ports: {
            backlog: {
              async loadParent() {
                return parent;
              },
              async listScopedTasks() {
                return [task];
              },
              async claimTask() {
                events.push("backlog:claim");
              },
              async markTaskDone() {
                events.push("backlog:done");
              },
            },
            workspace: {
              async createCoordinatorWorkspace() {
                events.push("workspace:create-coordinator");
                return {
                  path: "/worktrees/coordinator",
                  branch: "coordinator/parent-11",
                };
              },
              async createTaskWorkspace() {
                events.push("workspace:create-task");
                return {
                  path: "/worktrees/task-13",
                  branch: "task/13-one-accepted-task",
                };
              },
              async mergeTaskIntoCoordinator() {
                events.push("workspace:merge-task");
                return mergeResult;
              },
              async hasIntegratedChanges() {
                events.push("workspace:has-integrated-changes");
                return true;
              },
              async pushCoordinatorBranch() {
                events.push("workspace:push-coordinator");
              },
            },
            agentRunner: {
              async runWorker() {
                events.push("agent:worker");
                return { summary: "Implemented task 13" };
              },
              async runReviewer() {
                events.push("agent:reviewer");
                return { findings: [] };
              },
            },
            verifier: {
              async verify(options) {
                events.push(`verify:${options.target}`);
                if (options.target === "task") {
                  return {
                    target: options.target,
                    passed: taskVerification.passed,
                    summary: taskVerification.summary,
                  };
                }
                return {
                  target: options.target,
                  passed: true,
                  summary: "coordinator verification passed",
                };
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
      ).rejects.toThrow(expectedError);

      for (const forbiddenEvent of forbiddenEvents) {
        expect(events).not.toContain(forbiddenEvent);
      }
      expect(events).not.toContain("verify:coordinator");
      expect(events).not.toContain("workspace:push-coordinator");
    },
  );

  it("does not silently ignore P0/P1 reviewer findings or publish a PR", async () => {
    const events: string[] = [];
    const parent: ParentEffort = { id: "parent-11", title: "Parent" };
    const task: ScopedTask = { id: "task-13", title: "One accepted task" };

    await expect(
      coordinateImplementation({
        parent: { type: "github-issue", issueNumber: 11 },
        ports: {
          backlog: {
            async loadParent() {
              return parent;
            },
            async listScopedTasks() {
              return [task];
            },
            async claimTask() {
              events.push("backlog:claim");
            },
            async markTaskDone() {
              events.push("backlog:done");
            },
          },
          workspace: {
            async createCoordinatorWorkspace() {
              events.push("workspace:create-coordinator");
              return {
                path: "/worktrees/coordinator",
                branch: "coordinator/parent-11",
              };
            },
            async createTaskWorkspace() {
              events.push("workspace:create-task");
              return {
                path: "/worktrees/task-13",
                branch: "task/13-one-accepted-task",
              };
            },
            async mergeTaskIntoCoordinator() {
              events.push("workspace:merge-task");
              return { merged: true };
            },
            async hasIntegratedChanges() {
              events.push("workspace:has-integrated-changes");
              return true;
            },
            async pushCoordinatorBranch() {
              events.push("workspace:push-coordinator");
            },
          },
          agentRunner: {
            async runWorker() {
              events.push("agent:worker");
              return { summary: "Implemented task 13" };
            },
            async runReviewer() {
              events.push("agent:reviewer");
              return { findings: [{ severity: "P1", title: "Blocking bug" }] };
            },
          },
          verifier: {
            async verify(options) {
              events.push(`verify:${options.target}`);
              return {
                target: options.target,
                passed: true,
                summary: `${options.target} verification passed`,
              };
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
      "Blocking reviewer findings for task-13 require the #14 review-loop/needs-attention behavior",
    );

    expect(events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim",
      "workspace:create-task",
      "agent:worker",
      "agent:reviewer",
    ]);
  });

  it("coordinates one ready task through acceptance, verification, merge, and PR recommendation", async () => {
    const events: string[] = [];
    const parentRef: ParentRef = { type: "github-issue", issueNumber: 11 };
    const parent: ParentEffort = { id: "parent-11", title: "Parent" };
    const task: ScopedTask = { id: "task-13", title: "One accepted task" };
    const publishedBodies: string[] = [];

    const result = await coordinateImplementation({
      parent: parentRef,
      ports: {
        backlog: {
          async loadParent() {
            return parent;
          },
          async listScopedTasks() {
            return [task];
          },
          async claimTask(claimedTask) {
            expect(claimedTask).toBe(task);
            events.push("backlog:claim");
          },
          async markTaskDone(doneTask, outcome) {
            expect(doneTask).toBe(task);
            expect(outcome.acceptance).toBe("accepted");
            events.push("backlog:done");
          },
        },
        workspace: {
          async createCoordinatorWorkspace(options) {
            expect(options.parent).toBe(parent);
            events.push("workspace:create-coordinator");
            return {
              id: "coordinator-workspace",
              path: "/worktrees/coordinator",
              branch: "coordinator/parent-11",
            };
          },
          async createTaskWorkspace(options) {
            expect(options.coordinatorWorkspace.branch).toBe(
              "coordinator/parent-11",
            );
            expect(options.task).toBe(task);
            events.push("workspace:create-task");
            return {
              id: "task-workspace",
              path: "/worktrees/task-13",
              branch: "task/13-one-accepted-task",
            };
          },
          async mergeTaskIntoCoordinator(options) {
            expect(options.taskWorkspace.branch).toBe(
              "task/13-one-accepted-task",
            );
            events.push("workspace:merge-task");
            return { merged: true };
          },
          async hasIntegratedChanges() {
            return true;
          },
          async pushCoordinatorBranch(options) {
            expect(options.coordinatorWorkspace.branch).toBe(
              "coordinator/parent-11",
            );
            events.push("workspace:push-coordinator");
          },
        },
        agentRunner: {
          async runWorker(options) {
            expect(options.task).toBe(task);
            events.push("agent:worker");
            return { summary: "Implemented task 13" };
          },
          async runReviewer(options) {
            expect(options.task).toBe(task);
            events.push("agent:reviewer");
            return { findings: [{ severity: "P2", title: "Nit" }] };
          },
        },
        verifier: {
          async verify(options) {
            events.push(`verify:${options.target}`);
            return {
              target: options.target,
              passed: true,
              summary: `${options.target} verification passed`,
            };
          },
        },
        pullRequests: {
          async createOrUpdate(options): Promise<CoordinationPullRequest> {
            publishedBodies.push(options.body);
            events.push("pull-request:publish");
            return {
              id: "pr-13",
              url: "https://example.test/pr/13",
              body: options.body,
            };
          },
        },
      },
    });

    expect(events).toEqual([
      "workspace:create-coordinator",
      "backlog:claim",
      "workspace:create-task",
      "agent:worker",
      "agent:reviewer",
      "verify:task",
      "workspace:merge-task",
      "backlog:done",
      "verify:coordinator",
      "workspace:push-coordinator",
      "pull-request:publish",
    ]);
    expect(result.completedTasks).toEqual([
      {
        task,
        branch: "task/13-one-accepted-task",
        workspace: "/worktrees/task-13",
        verification: {
          target: "task",
          passed: true,
          summary: "task verification passed",
        },
      },
    ]);
    expect(result.coordinatorWorkspace).toEqual({
      id: "coordinator-workspace",
      path: "/worktrees/coordinator",
      branch: "coordinator/parent-11",
    });
    expect(result.coordinatorVerification).toEqual({
      target: "coordinator",
      passed: true,
      summary: "coordinator verification passed",
    });
    expect(result.pullRequest).toEqual({
      id: "pr-13",
      url: "https://example.test/pr/13",
      body: publishedBodies[0],
    });
    expect(result.mergeRecommendation).toBe("recommend-merge");
    expect(publishedBodies[0]).toContain("One accepted task");
    expect(publishedBodies[0]).toContain("coordinator verification passed");
    expect(publishedBodies[0]).toContain("Recommend merge");
  });
});
