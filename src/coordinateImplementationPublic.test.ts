import { describe, expect, it } from "vitest";
import type { AgentProvider } from "./AgentProvider.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import {
  coordinateImplementation,
  runImplementationCoordination,
  type CoordinationPullRequest,
  type ImplementationCoordinationAdapterFactories,
  type ImplementationCoordinationPorts,
  type ParentEffort,
  type ScopedTask,
} from "./ImplementationCoordination.js";

const fakeAgent = (name: string): AgentProvider => ({
  name,
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "echo", args: ["{}"] }),
  parseStreamLine: () => [],
});

const fakeSandbox = (name: string): SandboxProvider => ({
  tag: "none",
  name,
  env: {},
  create: async () => ({
    worktreePath: "/tmp/fake",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    interactiveExec: async () => ({ exitCode: 0 }),
    close: async () => {},
  }),
});

const parent: ParentEffort = { id: "#18", title: "Parent task" };
const task: ScopedTask = { id: "#19", title: "Child task" };

const successfulPorts = (
  events: string[],
): ImplementationCoordinationPorts => ({
  backlog: {
    loadParent: async (ref) => {
      events.push(`load-parent:${ref.type}:${ref.issueNumber}`);
      return parent;
    },
    listScopedTasks: async () => [task],
    claimTask: async () => {},
    releaseTask: async () => {},
    markTaskDone: async () => {},
    markTaskBlocked: async () => {},
    markTaskNeedsAttention: async () => {},
  },
  workspace: {
    createCoordinatorWorkspace: async () => ({
      path: "/worktrees/coordinator",
      branch: "sandcastle/coordinator/18",
    }),
    createTaskWorkspace: async () => ({
      path: "/worktrees/task-19",
      branch: "sandcastle/task/19",
    }),
    mergeTaskIntoCoordinator: async () => ({ merged: true }),
    hasIntegratedChanges: async () => true,
    pushCoordinatorBranch: async () => {},
  },
  agentRunner: {
    runWorker: async () => ({ summary: "implemented" }),
    runReviewer: async () => ({ findings: [] }),
  },
  verifier: {
    verify: async ({ target }) => ({
      target,
      passed: true,
      summary: `${target} verification passed`,
    }),
  },
  pullRequests: {
    createOrUpdate: async (options): Promise<CoordinationPullRequest> => ({
      url: "https://example.test/pr/18",
      body: options.body,
    }),
  },
});

describe("public coordinateImplementation", () => {
  it("constructs GitHub backlog, local workspace, local agent runner, verifier, and PR publisher defaults for a parent issue", async () => {
    const events: string[] = [];
    const factories: ImplementationCoordinationAdapterFactories = {
      backlog: (options) => {
        events.push(
          `factory:backlog:${options.parentIssue}:${options.cwd ?? "default"}:${options.repo ?? "default"}`,
        );
        return successfulPorts(events).backlog;
      },
      workspace: (options) => {
        events.push(
          `factory:workspace:${options.cwd ?? "default"}:${options.targetBranch}:${options.coordinatorBranch ?? "generated"}`,
        );
        return successfulPorts(events).workspace!;
      },
      agentRunner: (options) => {
        events.push(
          `factory:agent:${options.workerAgent.name}:${options.reviewerAgent?.name}:${options.sandbox.name}`,
        );
        return successfulPorts(events).agentRunner!;
      },
      verifier: (options) => {
        events.push(`factory:verifier:${options.commands.join(",")}`);
        return successfulPorts(events).verifier!;
      },
      pullRequests: (options) => {
        events.push(
          `factory:pr:${options.baseBranch}:${String(options.draft)}:${options.cwd ?? "default"}`,
        );
        return successfulPorts(events).pullRequests;
      },
    };

    const result = await coordinateImplementation({
      parentIssue: 18,
      agent: fakeAgent("worker"),
      adapterFactories: factories,
    });

    expect(events).toEqual([
      "factory:backlog:18:default:default",
      "factory:workspace:default:main:generated",
      "factory:agent:worker:worker:no-sandbox",
      "factory:verifier:npm run typecheck",
      "factory:pr:main:false:default",
      "load-parent:github-issue:18",
    ]);
    expect(result.pullRequest?.url).toBe("https://example.test/pr/18");
    expect(result.completedTasks).toHaveLength(1);
    expect(result.mergeRecommendation).toBe("recommend-merge");
  });

  it("maps configured issue numbers, reviewer, execution, verification, PR, repo, cwd, and branch options into adapters and policy", async () => {
    const events: string[] = [];
    const sandbox = fakeSandbox("custom-sandbox");
    const factories: ImplementationCoordinationAdapterFactories = {
      backlog: (options) => {
        events.push(
          `backlog:${options.parentIssue}:${options.issueNumbers?.join("+")}:${options.repo}:${options.cwd}`,
        );
        return successfulPorts(events).backlog;
      },
      workspace: (options) => {
        events.push(
          `workspace:${options.cwd}:${options.targetBranch}:${options.coordinatorBranch}:${options.taskBranchPrefix}:${options.remote}`,
        );
        return successfulPorts(events).workspace!;
      },
      agentRunner: (options) => {
        events.push(
          `agent:${options.workerAgent.name}:${options.reviewerAgent?.name}:${options.sandbox.name}:${options.workerMaxIterations}:${options.reviewerMaxIterations}:${options.logging?.type}`,
        );
        return successfulPorts(events).agentRunner!;
      },
      verifier: (options) => {
        events.push(`verifier:${options.commands.join("+")}:${options.cwd}`);
        return successfulPorts(events).verifier!;
      },
      pullRequests: (options) => {
        events.push(
          `pr:${options.baseBranch}:${String(options.draft)}:${options.repo}:${options.cwd}`,
        );
        return successfulPorts(events).pullRequests;
      },
    };

    await coordinateImplementation({
      parentIssue: 18,
      issueNumbers: [19, 20],
      agent: fakeAgent("worker"),
      reviewerAgent: fakeAgent("reviewer"),
      cwd: "/repo",
      repo: "Whamp/sandcastle",
      coordinatorBranch: "coord/18",
      targetBranch: "develop",
      taskBranchPrefix: "task",
      remote: "upstream",
      execution: {
        sandbox,
        workerMaxIterations: 3,
        reviewerMaxIterations: 2,
        maxReviewRounds: 4,
        logging: { type: "stdout" },
      },
      verification: { commands: ["npm run typecheck", "npm test"] },
      pr: { draft: true, baseBranch: "release" },
      adapterFactories: factories,
    });

    expect(events.slice(0, 5)).toEqual([
      "backlog:18:19+20:Whamp/sandcastle:/repo",
      "workspace:/repo:develop:coord/18:task:upstream",
      "agent:worker:reviewer:custom-sandbox:3:2:stdout",
      "verifier:npm run typecheck+npm test:/repo",
      "pr:release:true:Whamp/sandcastle:/repo",
    ]);
  });

  it("keeps runImplementationCoordination available for fake-port core tests", async () => {
    const events: string[] = [];

    const result = await runImplementationCoordination({
      parent: { type: "github-issue", issueNumber: 18 },
      ports: successfulPorts(events),
    });

    expect(result.pullRequest?.url).toBe("https://example.test/pr/18");
  });

  it("does not expose an automatic PR merge operation", () => {
    expect("merge" in coordinateImplementation).toBe(false);
  });
});
