import { describe, expect, it } from "vitest";
import { renderCoordinationManifest } from "./CoordinationManifest.js";
import {
  finalizeIntegration,
  GitHubIntegrationFinalizationPullRequestAdapter,
} from "./index.js";

interface FakePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly body: string;
  readonly title?: string;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly mergedAt?: string | null;
  readonly mergeCommit?: { readonly oid: string } | null;
  readonly comments: Array<{ body: string; createdAt?: string }>;
}

const manifestBody = () =>
  renderCoordinationManifest({
    parent: { id: "#21", title: "Parent PRD" },
    coordinatorBranch: "sandcastle/coordinator/21",
    targetBranch: "main",
    baseBranch: "main",
    acceptedForIntegrationTasks: [
      {
        task: { id: "#24", title: "GitHub finalization path" },
        branch: "sandcastle/task/24-github-finalization",
      },
    ],
    mergeRecommendation: "recommend-merge",
    publishedAt: "2026-04-24T10:00:00.000Z",
  });

const createFakeGh = (pullRequests: FakePullRequest[]) => {
  const commands: string[][] = [];
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  const pullRequestsByUrl = new Map(
    pullRequests.map((pullRequest) => [pullRequest.url, pullRequest]),
  );

  const gh = async (args: string[]): Promise<string> => {
    commands.push(args);

    if (args[0] !== "pr") {
      throw new Error(`Unsupported gh args: ${args.join(" ")}`);
    }

    if (args[1] === "view") {
      const ref = args[2] ?? "";
      const pullRequest = ref.startsWith("http")
        ? pullRequestsByUrl.get(ref)
        : pullRequestsByNumber.get(Number(ref));
      if (!pullRequest) throw new Error(`Unknown pull request ${ref}`);
      return JSON.stringify(pullRequest);
    }

    if (args[1] === "comment") {
      const ref = args[2] ?? "";
      const body = args[args.indexOf("--body") + 1];
      const pullRequest = ref.startsWith("http")
        ? pullRequestsByUrl.get(ref)
        : pullRequestsByNumber.get(Number(ref));
      if (!pullRequest || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }
      pullRequest.comments.push({
        body,
        createdAt: "2026-04-24T11:00:00.000Z",
      });
      return "";
    }

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };

  return { gh, commands };
};

const childIssueMutationCommands = (commands: string[][]) =>
  commands.filter(
    (args) =>
      args[0] === "issue" &&
      (args[1] === "comment" || args[1] === "close" || args[1] === "edit"),
  );

describe("GitHubIntegrationFinalizationPullRequestAdapter", () => {
  it("loads PR state, branch information, merge metadata, body, and comments", async () => {
    const pullRequest: FakePullRequest = {
      number: 27,
      url: "https://github.com/Whamp/sandcastle/pull/27",
      state: "MERGED",
      body: manifestBody(),
      headRefName: "sandcastle/coordinator/21",
      baseRefName: "main",
      mergedAt: "2026-04-24T12:00:00.000Z",
      mergeCommit: { oid: "abc123" },
      comments: [{ body: "prior finalization note" }],
    };
    const { gh } = createFakeGh([pullRequest]);

    const loaded = await new GitHubIntegrationFinalizationPullRequestAdapter({
      gh,
    }).load({ number: 27 });

    expect(loaded).toEqual({
      id: "27",
      number: 27,
      url: "https://github.com/Whamp/sandcastle/pull/27",
      state: "closed",
      merged: true,
      body: manifestBody(),
      landedCommit: "abc123",
      headBranch: "sandcastle/coordinator/21",
      baseBranch: "main",
      comments: [{ body: "prior finalization note" }],
    });
  });
});

describe("finalizeIntegration GitHub path", () => {
  it("loads an open coordination PR by number, reports pending on the PR, and mutates no child issues", async () => {
    const pullRequest: FakePullRequest = {
      number: 24,
      url: "https://github.com/Whamp/sandcastle/pull/24",
      state: "OPEN",
      body: manifestBody(),
      headRefName: "sandcastle/coordinator/21",
      baseRefName: "main",
      mergedAt: null,
      mergeCommit: null,
      comments: [],
    };
    const { gh, commands } = createFakeGh([pullRequest]);

    const result = await finalizeIntegration({
      coordinationPullRequest: 24,
      repo: "Whamp/sandcastle",
      gh,
    });

    expect(result.outcome).toBe("pending");
    expect(result.reason).toBe("coordination-pr-open");
    expect(pullRequest.comments).toHaveLength(1);
    expect(pullRequest.comments[0]!.body).toContain(
      "Integration Finalization pending",
    );
    expect(pullRequest.comments[0]!.body).toContain("coordination-pr-open");
    expect(commands).toContainEqual([
      "pr",
      "view",
      "24",
      "--json",
      "number,url,state,mergedAt,mergeCommit,headRefName,baseRefName,body,comments",
      "--repo",
      "Whamp/sandcastle",
    ]);
    expect(commands).toContainEqual([
      "pr",
      "comment",
      "24",
      "--body",
      pullRequest.comments[0]!.body,
      "--repo",
      "Whamp/sandcastle",
    ]);
    expect(childIssueMutationCommands(commands)).toEqual([]);
  });

  it("loads a closed-unmerged coordination PR by URL, reports finalization needs attention on the PR, and mutates no child issues", async () => {
    const pullRequest: FakePullRequest = {
      number: 25,
      url: "https://github.com/Whamp/sandcastle/pull/25",
      state: "CLOSED",
      body: manifestBody(),
      headRefName: "sandcastle/coordinator/21",
      baseRefName: "main",
      mergedAt: null,
      mergeCommit: null,
      comments: [],
    };
    const { gh, commands } = createFakeGh([pullRequest]);

    const result = await finalizeIntegration({
      coordinationPullRequest: pullRequest.url,
      gh,
    });

    expect(result.outcome).toBe("finalization-needs-attention");
    expect(result.reason).toBe("coordination-pr-closed-unmerged");
    expect(pullRequest.comments).toHaveLength(1);
    expect(pullRequest.comments[0]!.body).toContain(
      "Integration Finalization needs attention",
    );
    expect(pullRequest.comments[0]!.body).toContain(
      "coordination-pr-closed-unmerged",
    );
    expect(commands).toContainEqual([
      "pr",
      "view",
      pullRequest.url,
      "--json",
      "number,url,state,mergedAt,mergeCommit,headRefName,baseRefName,body,comments",
    ]);
    expect(commands).toContainEqual([
      "pr",
      "comment",
      pullRequest.url,
      "--body",
      pullRequest.comments[0]!.body,
    ]);
    expect(childIssueMutationCommands(commands)).toEqual([]);
  });

  it.each([
    ["coordination-manifest-missing" as const, "Human-only body"],
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
    "reports %s on the coordination PR and mutates no child issues through the public GitHub path",
    async (reason, body) => {
      const pullRequest: FakePullRequest = {
        number: 26,
        url: "https://github.com/Whamp/sandcastle/pull/26",
        state: "MERGED",
        body,
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: "abc123" },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest]);

      const result = await finalizeIntegration({
        coordinationPullRequest: 26,
        repo: "Whamp/sandcastle",
        gh,
      });

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe(reason);
      expect(pullRequest.comments).toHaveLength(1);
      expect(pullRequest.comments[0]!.body).toContain(
        "Integration Finalization needs attention",
      );
      expect(pullRequest.comments[0]!.body).toContain(reason);
      expect(childIssueMutationCommands(commands)).toEqual([]);
    },
  );
});
