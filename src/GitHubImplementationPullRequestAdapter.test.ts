import { describe, expect, it } from "vitest";
import {
  GitHubImplementationPullRequestAdapter,
  renderImplementationCoordinationReport,
} from "./GitHubImplementationPullRequestAdapter.js";
import type {
  CreateOrUpdateCoordinationPullRequestOptions,
  ImplementationCoordinationPullRequestPort,
} from "./ImplementationCoordination.js";

const baseOptions: CreateOrUpdateCoordinationPullRequestOptions = {
  parent: { id: "#11", title: "Parent spec" },
  acceptedForIntegrationTasks: [
    {
      task: { id: "#17", title: "Add PR publisher" },
      branch: "task/17-github-pr-publisher",
      workspace: "/worktrees/task-17",
      verification: { passed: true, summary: "task tests passed" },
      reviewFindings: [{ severity: "P2", title: "Follow-up polish" }],
    },
  ],
  blockedTasks: [
    {
      task: { id: "#18", title: "Public default wiring" },
      blockers: ["#17"],
    },
  ],
  needsAttentionTasks: [
    {
      task: { id: "#19", title: "Runtime edge case" },
      reason: "worker-failed",
      summary: "manual investigation needed",
      branch: "task/19-runtime-edge-case",
      workspace: "/worktrees/task-19",
    },
  ],
  nonBlockingReviewFindings: [
    {
      severity: "P2",
      title: "Follow-up polish",
      body: "Can be handled later.",
      file: "src/example.ts",
      line: 7,
    },
    { severity: "P3", title: "Nitpick" },
  ],
  coordinatorWorkspace: {
    path: "/worktrees/coordinator",
    branch: "epic/implementation-coordination-engine",
  },
  verification: {
    passed: true,
    summary: "npm run typecheck passed",
    commands: [
      {
        command: "npm run typecheck",
        cwd: "/repo",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      },
    ],
  },
  mergeRecommendation: "do-not-recommend-merge-yet",
  body: "",
};

const createFakeGh = (
  existingPrs: Array<{ number: number; url: string }> = [],
) => {
  const commands: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    commands.push(args);

    if (args[0] !== "pr") {
      throw new Error(`Unsupported gh args: ${args.join(" ")}`);
    }

    if (args[1] === "list") {
      return JSON.stringify(existingPrs);
    }

    if (args[1] === "create") {
      return "https://github.com/Whamp/sandcastle/pull/21\n";
    }

    if (args[1] === "edit") {
      return "";
    }

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };

  return { gh, commands };
};

describe("renderImplementationCoordinationReport", () => {
  it("includes the durable coordination report sections and recommendation marker", () => {
    const body = renderImplementationCoordinationReport(baseOptions);

    expect(body).toContain("## Parent issue/spec");
    expect(body).toContain("Parent spec (#11)");
    expect(body).toContain("## Accepted for integration tasks");
    expect(body).toContain("Add PR publisher (#17)");
    expect(body).toContain("## Blocked tasks");
    expect(body).toContain("Public default wiring (#18) blocked by #17");
    expect(body).toContain("## Needs-attention tasks");
    expect(body).toContain("Runtime edge case (#19): worker-failed");
    expect(body).toContain("## Verification summary");
    expect(body).toContain("npm run typecheck passed");
    expect(body).toContain("## P2/P3 reviewer findings");
    expect(body).toContain("P2: Follow-up polish (src/example.ts:7)");
    expect(body).toContain("P3: Nitpick");
    expect(body).toContain("## Merge recommendation");
    expect(body).toContain("**Do not recommend merge yet**");
    expect(body).not.toContain("/worktrees/task-17");
    expect(body).not.toContain("/worktrees/task-19");
    expect(body).not.toContain("/worktrees/coordinator");
    expect(body).not.toContain("/repo");
    expect(body).toContain("`npm run typecheck`: exit 0");
  });
});

describe("GitHubImplementationPullRequestAdapter", () => {
  it("creates a PR through the pull request port when no open PR exists for the coordinator branch", async () => {
    const { gh, commands } = createFakeGh();
    const adapter: ImplementationCoordinationPullRequestPort =
      new GitHubImplementationPullRequestAdapter({ gh, baseBranch: "main" });
    const body = renderImplementationCoordinationReport({
      ...baseOptions,
      blockedTasks: [],
      needsAttentionTasks: [],
      mergeRecommendation: "recommend-merge",
    });

    const pr = await adapter.createOrUpdate({
      ...baseOptions,
      blockedTasks: [],
      needsAttentionTasks: [],
      mergeRecommendation: "recommend-merge",
      body,
    });

    expect(pr).toEqual({
      url: "https://github.com/Whamp/sandcastle/pull/21",
      body,
    });
    expect(commands).toContainEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      "epic/implementation-coordination-engine",
      "--json",
      "number,url",
    ]);
    expect(commands).toContainEqual([
      "pr",
      "create",
      "--head",
      "epic/implementation-coordination-engine",
      "--base",
      "main",
      "--title",
      "Implementation coordination: Parent spec",
      "--body",
      body,
    ]);
    expect(commands.flat().join(" ")).not.toContain("pr merge");
    expect(body).toContain("**Recommend merge**");
  });

  it("updates an existing open PR for the coordinator branch", async () => {
    const { gh, commands } = createFakeGh([
      { number: 20, url: "https://github.com/Whamp/sandcastle/pull/20" },
    ]);
    const adapter = new GitHubImplementationPullRequestAdapter({ gh });
    const body = renderImplementationCoordinationReport(baseOptions);

    const pr = await adapter.createOrUpdate({ ...baseOptions, body });

    expect(pr).toEqual({
      id: "20",
      url: "https://github.com/Whamp/sandcastle/pull/20",
      body,
    });
    expect(commands).toContainEqual([
      "pr",
      "edit",
      "20",
      "--title",
      "Implementation coordination: Parent spec",
      "--body",
      body,
    ]);
    expect(commands.flat().join(" ")).not.toContain("pr merge");
  });

  it("does not expose merge behavior and rejects empty publication inputs", async () => {
    const { gh, commands } = createFakeGh();
    const adapter = new GitHubImplementationPullRequestAdapter({ gh });

    expect("merge" in adapter).toBe(false);
    await expect(
      adapter.createOrUpdate({
        ...baseOptions,
        acceptedForIntegrationTasks: [],
      }),
    ).rejects.toThrow("no issue branch was accepted");
    expect(commands).toEqual([]);
  });
});
