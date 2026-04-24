import { describe, expect, it } from "vitest";
import { parseCoordinationManifestFromBody } from "./CoordinationManifest.js";
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
  existingPrs: Array<{ number: number; url: string; baseRefName?: string }> = [],
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
      new GitHubImplementationPullRequestAdapter({
        gh,
        baseBranch: "main",
        now: () => new Date("2026-04-24T10:00:00.000Z"),
      });
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

    expect(pr.url).toBe("https://github.com/Whamp/sandcastle/pull/21");
    expect(pr.body).toContain(body);
    expect(
      parseCoordinationManifestFromBody(pr.body ?? "")?.publication,
    ).toMatchObject({
      publishedAt: "2026-04-24T10:00:00.000Z",
      mergeRecommendation: "recommend-merge",
      acceptedTaskCount: 1,
    });
    expect(commands).toContainEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      "epic/implementation-coordination-engine",
      "--json",
      "number,url,baseRefName",
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
      pr.body ?? "",
    ]);
    expect(commands.flat().join(" ")).not.toContain("pr merge");
    expect(body).toContain("**Recommend merge**");
  });

  it("updates an existing open PR for the coordinator branch", async () => {
    const { gh, commands } = createFakeGh([
      {
        number: 20,
        url: "https://github.com/Whamp/sandcastle/pull/20",
        baseRefName: "release",
      },
    ]);
    const adapter = new GitHubImplementationPullRequestAdapter({
      gh,
      baseBranch: "main",
      targetBranch: "develop",
      now: () => new Date("2026-04-24T10:00:00.000Z"),
    });
    const body = renderImplementationCoordinationReport(baseOptions);

    const pr = await adapter.createOrUpdate({ ...baseOptions, body });

    expect(pr.id).toBe("20");
    expect(pr.url).toBe("https://github.com/Whamp/sandcastle/pull/20");
    expect(pr.body).toContain(body);
    expect(parseCoordinationManifestFromBody(pr.body ?? "")).toMatchObject({
      targetBranch: "release",
      baseBranch: "release",
      publication: {
        publishedAt: "2026-04-24T10:00:00.000Z",
        mergeRecommendation: "do-not-recommend-merge-yet",
        acceptedTaskCount: 1,
      },
    });
    expect(commands).toContainEqual([
      "pr",
      "edit",
      "20",
      "--title",
      "Implementation coordination: Parent spec",
      "--body",
      pr.body ?? "",
    ]);
    expect(commands.flat().join(" ")).not.toContain("pr merge");
  });

  it("publishes a single fresh coordination manifest while preserving the human-readable report", async () => {
    const { gh, commands } = createFakeGh();
    const adapter = new GitHubImplementationPullRequestAdapter({
      gh,
      baseBranch: "release",
      targetBranch: "main",
      now: () => new Date("2026-04-24T10:00:00.000Z"),
    });
    const humanReport = renderImplementationCoordinationReport(baseOptions);
    const staleManifestBody = [
      humanReport,
      "<!-- sandcastle:coordination-manifest:start -->",
      "```json",
      JSON.stringify({
        kind: "sandcastle.coordination-manifest",
        version: 1,
        parentScope: { id: "#11", issueNumber: 11 },
        coordinatorBranch: "old/coordinator",
        targetBranch: "old-main",
        baseBranch: "old-base",
        acceptedTasks: [{ id: "#999", issueNumber: 999, branch: "old/task" }],
        publication: {
          publisher: "sandcastle",
          publishedAt: "2026-01-01T00:00:00.000Z",
          mergeRecommendation: "do-not-recommend-merge-yet",
          acceptedTaskCount: 1,
        },
      }),
      "```",
      "<!-- sandcastle:coordination-manifest:end -->",
    ].join("\n");

    const pr = await adapter.createOrUpdate({
      ...baseOptions,
      body: staleManifestBody,
    });

    const publishedBody = pr.body ?? "";
    expect(publishedBody).toContain(humanReport);
    expect(
      publishedBody.match(/sandcastle:coordination-manifest:start/g),
    ).toHaveLength(1);
    expect(publishedBody).not.toContain("#999");
    expect(parseCoordinationManifestFromBody(publishedBody)).toEqual({
      kind: "sandcastle.coordination-manifest",
      version: 1,
      parentScope: { id: "#11", issueNumber: 11, title: "Parent spec" },
      coordinatorBranch: "epic/implementation-coordination-engine",
      targetBranch: "release",
      baseBranch: "release",
      acceptedTasks: [
        {
          id: "#17",
          issueNumber: 17,
          title: "Add PR publisher",
          branch: "task/17-github-pr-publisher",
        },
      ],
      publication: {
        publisher: "sandcastle",
        publishedAt: "2026-04-24T10:00:00.000Z",
        mergeRecommendation: "do-not-recommend-merge-yet",
        acceptedTaskCount: 1,
      },
    });
    expect(commands).toContainEqual([
      "pr",
      "create",
      "--head",
      "epic/implementation-coordination-engine",
      "--base",
      "release",
      "--title",
      "Implementation coordination: Parent spec",
      "--body",
      pr.body ?? "",
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
