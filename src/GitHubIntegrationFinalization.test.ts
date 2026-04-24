import { exec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderCoordinationManifest } from "./CoordinationManifest.js";
import {
  formatTaskCoordinationComment,
  parseTaskCoordinationComment,
  type GitHubIssueComment,
  type TaskCoordinationComment,
} from "./GitHubIssueBacklog.js";
import {
  finalizeIntegration,
  GitHubIntegrationFinalizationLandingProofAdapter,
  GitHubIntegrationFinalizationPullRequestAdapter,
} from "./index.js";

const execAsync = promisify(exec);

const shellEscape = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

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

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: "OPEN" | "CLOSED";
  readonly comments: GitHubIssueComment[];
  readonly labels?: readonly string[];
  readonly url?: string;
}

const manifestBody = (
  acceptedForIntegrationTasks = [
    {
      task: { id: "#24", title: "GitHub finalization path" },
      branch: "sandcastle/task/24-github-finalization",
    },
  ],
) =>
  renderCoordinationManifest({
    parent: { id: "#21", title: "Parent PRD" },
    coordinatorBranch: "sandcastle/coordinator/21",
    targetBranch: "main",
    baseBranch: "main",
    acceptedForIntegrationTasks,
    mergeRecommendation: "recommend-merge",
    publishedAt: "2026-04-24T10:00:00.000Z",
  });

const acceptedForIntegrationComment = (
  issueNumber: number,
  branch: string,
): GitHubIssueComment => ({
  body: formatTaskCoordinationComment({
    kind: "sandcastle-task-coordination",
    version: 1,
    event: "accepted-for-integration",
    runId: `accepted-${issueNumber}`,
    executionMode: "host",
    recordedAt: "2026-04-24T10:30:00.000Z",
    branch,
    reason: "Accepted into the coordination PR.",
  }),
  createdAt: "2026-04-24T10:30:00.000Z",
});

const lifecycleComment = (
  issueNumber: number,
  event: TaskCoordinationComment["event"],
  recordedAt: string,
  overrides: Partial<TaskCoordinationComment> = {},
): GitHubIssueComment => ({
  body: formatTaskCoordinationComment({
    kind: "sandcastle-task-coordination",
    version: 1,
    event,
    runId: `${event}-${issueNumber}`,
    executionMode: "host",
    recordedAt,
    ...overrides,
  }),
  createdAt: recordedAt,
});

const doneComment = (
  issueNumber: number,
  branch: string,
  landedCommit: string,
): GitHubIssueComment => ({
  body: formatTaskCoordinationComment({
    kind: "sandcastle-task-coordination",
    version: 1,
    event: "done",
    runId: `done-${issueNumber}`,
    executionMode: "host",
    recordedAt: "2026-04-24T11:30:00.000Z",
    branch,
    commits: [landedCommit],
    reason: `Accepted task landed at ${landedCommit}.`,
  }),
  createdAt: "2026-04-24T11:30:00.000Z",
});

const createFakeGh = (
  pullRequests: FakePullRequest[],
  issues: FakeIssue[] = [],
) => {
  const commands: string[][] = [];
  const pullRequestsByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  const pullRequestsByUrl = new Map(
    pullRequests.map((pullRequest) => [pullRequest.url, pullRequest]),
  );
  const issuesByNumber = new Map(issues.map((issue) => [issue.number, issue]));

  const gh = async (args: string[]): Promise<string> => {
    commands.push(args);

    if (args[0] === "issue" && args[1] === "view") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) throw new Error(`Unknown issue ${args[2]}`);
      return JSON.stringify({
        ...issue,
        labels: issue.labels ?? [],
      });
    }

    if (args[0] === "issue" && args[1] === "comment") {
      const issue = issuesByNumber.get(Number(args[2]));
      const body = args[args.indexOf("--body") + 1];
      if (!issue || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }
      issue.comments.push({
        body,
        createdAt: "2026-04-24T11:30:00.000Z",
      });
      return "";
    }

    if (args[0] === "issue" && args[1] === "close") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) throw new Error(`Unknown issue ${args[2]}`);
      issue.state = "CLOSED";
      return "";
    }

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

const prohibitedAutomationCommands = (commands: string[][]) =>
  commands.filter((args) => {
    const command = args.join(" ");
    return (
      command.startsWith("pr merge") ||
      command.startsWith("pr checks") ||
      command.startsWith("run ") ||
      command.startsWith("workflow ") ||
      command.includes(" release") ||
      command.includes(" deploy")
    );
  });

const setupMergedRepo = async () => {
  const repo = await mkdtemp(join(tmpdir(), "sandcastle-finalization-"));
  await execAsync("git init -b main", { cwd: repo });
  await execAsync('git config user.email "test@test.com"', { cwd: repo });
  await execAsync('git config user.name "Test"', { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  await execAsync("git add README.md && git commit -m base", { cwd: repo });
  await writeFile(join(repo, "finalized.txt"), "landed\n");
  await execAsync(
    `git add finalized.txt && git commit -m ${shellEscape("landed coordination PR")}`,
    { cwd: repo },
  );
  const landedCommit = (
    await execAsync("git rev-parse HEAD", { cwd: repo })
  ).stdout.trim();

  return { repo, landedCommit };
};

const doneEvents = (issue: FakeIssue): TaskCoordinationComment[] =>
  issue.comments
    .map((comment) => parseTaskCoordinationComment(comment.body))
    .filter(
      (comment): comment is TaskCoordinationComment =>
        comment?.event === "done",
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

describe("GitHubIntegrationFinalizationLandingProofAdapter", () => {
  it("proves the GitHub-reported landed commit is an ancestor of the current target branch in a real repository", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      await execAsync("git checkout --orphan unrelated", { cwd: repo });
      await execAsync("git rm -rf .", { cwd: repo });
      await writeFile(join(repo, "unrelated.txt"), "unrelated\n");
      await execAsync("git add unrelated.txt && git commit -m unrelated", {
        cwd: repo,
      });

      const proof = new GitHubIntegrationFinalizationLandingProofAdapter({
        cwd: repo,
      });

      await expect(
        proof.prove({ targetBranch: "main", landedCommit }),
      ).resolves.toMatchObject({ passed: true });
      await expect(
        proof.prove({ targetBranch: "unrelated", landedCommit }),
      ).resolves.toMatchObject({ passed: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("finalizeIntegration GitHub path", () => {
  it("treats repeated finalization of already-closed child issues with matching done events as already finalized without duplicate done events", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const branch = "sandcastle/task/23-finalization-core";
      const childIssue: FakeIssue = {
        number: 23,
        title: "Already finalized child task",
        body: "## Parent\n\n#21",
        state: "CLOSED",
        comments: [
          acceptedForIntegrationComment(23, branch),
          doneComment(23, branch, landedCommit),
        ],
      };
      const pullRequest: FakePullRequest = {
        number: 32,
        url: "https://github.com/Whamp/sandcastle/pull/32",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssue.title },
            branch,
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], [childIssue]);

      const result = await finalizeIntegration({
        coordinationPullRequest: 32,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("already-finalized");
      expect(result.reason).toBe("already-finalized");
      expect(result.finalizedTasks.map((task) => task.id)).toEqual(["#23"]);
      expect(childIssue.state).toBe("CLOSED");
      expect(doneEvents(childIssue)).toHaveLength(1);
      expect(childIssueMutationCommands(commands)).toEqual([]);
      expect(pullRequest.comments[0]!.body).toContain(
        "Integration Finalization already finalized",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("closes a child issue with a matching done event but still open without writing a duplicate done event", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const branch = "sandcastle/task/23-finalization-core";
      const childIssue: FakeIssue = {
        number: 23,
        title: "Done but still open child task",
        body: "## Parent\n\n#21",
        state: "OPEN",
        comments: [
          acceptedForIntegrationComment(23, branch),
          doneComment(23, branch, landedCommit),
        ],
      };
      const pullRequest: FakePullRequest = {
        number: 33,
        url: "https://github.com/Whamp/sandcastle/pull/33",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssue.title },
            branch,
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], [childIssue]);

      const result = await finalizeIntegration({
        coordinationPullRequest: 33,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalized");
      expect(result.reason).toBe("finalized");
      expect(result.finalizedTasks.map((task) => task.id)).toEqual(["#23"]);
      expect(childIssue.state).toBe("CLOSED");
      expect(doneEvents(childIssue)).toHaveLength(1);
      expect(childIssueMutationCommands(commands)).toEqual([
        ["issue", "close", "23", "--repo", "Whamp/sandcastle"],
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("can run finalization twice for the same proven coordination PR without duplicate done events", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const branch = "sandcastle/task/23-finalization-core";
      const childIssue: FakeIssue = {
        number: 23,
        title: "Finalize twice child task",
        body: "## Parent\n\n#21",
        state: "OPEN",
        comments: [acceptedForIntegrationComment(23, branch)],
      };
      const pullRequest: FakePullRequest = {
        number: 34,
        url: "https://github.com/Whamp/sandcastle/pull/34",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssue.title },
            branch,
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh } = createFakeGh([pullRequest], [childIssue]);

      const first = await finalizeIntegration({
        coordinationPullRequest: 34,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });
      const second = await finalizeIntegration({
        coordinationPullRequest: 34,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(first.outcome).toBe("finalized");
      expect(second.outcome).toBe("already-finalized");
      expect(childIssue.state).toBe("CLOSED");
      expect(doneEvents(childIssue)).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns retry-needed after a partial GitHub write failure and a later retry finishes the remaining child issue without duplicate done events", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const firstBranch = "sandcastle/task/23-finalization-core";
      const secondBranch = "sandcastle/task/24-github-adapters";
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Partial write first child task",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [acceptedForIntegrationComment(23, firstBranch)],
        },
        {
          number: 24,
          title: "Partial write second child task",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [acceptedForIntegrationComment(24, secondBranch)],
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 35,
        url: "https://github.com/Whamp/sandcastle/pull/35",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssues[0]!.title },
            branch: firstBranch,
          },
          {
            task: { id: "#24", title: childIssues[1]!.title },
            branch: secondBranch,
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const fake = createFakeGh([pullRequest], childIssues);
      let failCloseForSecondIssue = true;
      const gh = async (args: string[]) => {
        if (
          failCloseForSecondIssue &&
          args[0] === "issue" &&
          args[1] === "close" &&
          args[2] === "24"
        ) {
          failCloseForSecondIssue = false;
          fake.commands.push(args);
          throw new Error("simulated close failure for #24");
        }

        return fake.gh(args);
      };

      const first = await finalizeIntegration({
        coordinationPullRequest: 35,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(first.outcome).toBe("retry-needed");
      expect(first.reason).toBe("incomplete-write-retry-needed");
      expect(childIssues.map((issue) => issue.state)).toEqual([
        "CLOSED",
        "OPEN",
      ]);
      expect(doneEvents(childIssues[0]!)).toHaveLength(1);
      expect(doneEvents(childIssues[1]!)).toHaveLength(1);

      const second = await finalizeIntegration({
        coordinationPullRequest: 35,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(second.outcome).toBe("finalized");
      expect(second.reason).toBe("finalized");
      expect(childIssues.map((issue) => issue.state)).toEqual([
        "CLOSED",
        "CLOSED",
      ]);
      expect(doneEvents(childIssues[0]!)).toHaveLength(1);
      expect(doneEvents(childIssues[1]!)).toHaveLength(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("finalizes a merged coordination PR only after target-branch landing proof and accepted child task cross-check", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Add ports-first Integration Finalization core",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(
              23,
              "sandcastle/task/23-finalization-core",
            ),
          ],
          labels: ["ready-for-agent"],
          url: "https://github.com/Whamp/sandcastle/issues/23",
        },
        {
          number: 24,
          title: "Add GitHub Integration Finalization adapters",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(
              24,
              "sandcastle/task/24-github-adapters",
            ),
          ],
          labels: ["ready-for-agent"],
          url: "https://github.com/Whamp/sandcastle/issues/24",
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 28,
        url: "https://github.com/Whamp/sandcastle/pull/28",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssues[0]!.title },
            branch: "sandcastle/task/23-finalization-core",
          },
          {
            task: { id: "#24", title: childIssues[1]!.title },
            branch: "sandcastle/task/24-github-adapters",
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], childIssues);

      const result = await finalizeIntegration({
        coordinationPullRequest: 28,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalized");
      expect(result.reason).toBe("finalized");
      expect(result.finalizedTasks.map((task) => task.id)).toEqual([
        "#23",
        "#24",
      ]);
      expect(childIssues.map((issue) => issue.state)).toEqual([
        "CLOSED",
        "CLOSED",
      ]);
      expect(doneEvents(childIssues[0]!)).toMatchObject([
        {
          kind: "sandcastle-task-coordination",
          version: 1,
          event: "done",
          executionMode: "host",
          branch: "sandcastle/task/23-finalization-core",
          commits: [landedCommit],
        },
      ]);
      expect(doneEvents(childIssues[1]!)).toMatchObject([
        {
          kind: "sandcastle-task-coordination",
          version: 1,
          event: "done",
          executionMode: "host",
          branch: "sandcastle/task/24-github-adapters",
          commits: [landedCommit],
        },
      ]);
      expect(pullRequest.comments).toHaveLength(1);
      expect(pullRequest.comments[0]!.body).toContain(
        "Integration Finalization finalized",
      );
      expect(pullRequest.comments[0]!.body).toContain('"targetBranch": "main"');
      expect(pullRequest.comments[0]!.body).toContain(
        `"landedCommit": "${landedCommit}"`,
      );
      expect(pullRequest.comments[0]!.body).toContain('"id": "#23"');
      expect(pullRequest.comments[0]!.body).toContain('"id": "#24"');
      expect(commands).toEqual([
        [
          "pr",
          "view",
          "28",
          "--json",
          "number,url,state,mergedAt,mergeCommit,headRefName,baseRefName,body,comments",
          "--repo",
          "Whamp/sandcastle",
        ],
        [
          "issue",
          "view",
          "23",
          "--json",
          "number,title,body,state,comments,url,labels",
          "--jq",
          "{number: .number, title: .title, body: .body, state: .state, comments: .comments, url: .url, labels: [.labels[].name]}",
          "--repo",
          "Whamp/sandcastle",
        ],
        [
          "issue",
          "view",
          "24",
          "--json",
          "number,title,body,state,comments,url,labels",
          "--jq",
          "{number: .number, title: .title, body: .body, state: .state, comments: .comments, url: .url, labels: [.labels[].name]}",
          "--repo",
          "Whamp/sandcastle",
        ],
        [
          "issue",
          "comment",
          "23",
          "--body",
          childIssues[0]!.comments[1]!.body,
          "--repo",
          "Whamp/sandcastle",
        ],
        ["issue", "close", "23", "--repo", "Whamp/sandcastle"],
        [
          "issue",
          "comment",
          "24",
          "--body",
          childIssues[1]!.comments[1]!.body,
          "--repo",
          "Whamp/sandcastle",
        ],
        ["issue", "close", "24", "--repo", "Whamp/sandcastle"],
        [
          "pr",
          "comment",
          "28",
          "--body",
          pullRequest.comments[0]!.body,
          "--repo",
          "Whamp/sandcastle",
        ],
      ]);
      expect(prohibitedAutomationCommands(commands)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports finalization needs attention and mutates no child issues when any manifest child task is not accepted for integration", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Accepted child task",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(
              23,
              "sandcastle/task/23-finalization-core",
            ),
          ],
        },
        {
          number: 24,
          title: "Still only ready child task",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [],
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 29,
        url: "https://github.com/Whamp/sandcastle/pull/29",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssues[0]!.title },
            branch: "sandcastle/task/23-finalization-core",
          },
          {
            task: { id: "#24", title: childIssues[1]!.title },
            branch: "sandcastle/task/24-github-adapters",
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], childIssues);

      const result = await finalizeIntegration({
        coordinationPullRequest: 29,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe("accepted-task-state-inconsistent");
      expect(result.finalizedTasks).toEqual([]);
      expect(childIssues.map((issue) => issue.state)).toEqual(["OPEN", "OPEN"]);
      expect(childIssueMutationCommands(commands)).toEqual([]);
      expect(pullRequest.comments).toHaveLength(1);
      expect(pullRequest.comments[0]!.body).toContain(
        "accepted-task-state-inconsistent",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports finalization needs attention and mutates no child issues when the manifest target branch differs from the actual GitHub PR base branch", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Accepted child task for mismatched target branch",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(
              23,
              "sandcastle/task/23-finalization-core",
            ),
          ],
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 31,
        url: "https://github.com/Whamp/sandcastle/pull/31",
        state: "MERGED",
        body: renderCoordinationManifest({
          parent: { id: "#21", title: "Parent PRD" },
          coordinatorBranch: "sandcastle/coordinator/21",
          targetBranch: "release",
          baseBranch: "release",
          acceptedForIntegrationTasks: [
            {
              task: { id: "#23", title: childIssues[0]!.title },
              branch: "sandcastle/task/23-finalization-core",
            },
          ],
          mergeRecommendation: "recommend-merge",
          publishedAt: "2026-04-24T10:00:00.000Z",
        }),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], childIssues);

      const result = await finalizeIntegration({
        coordinationPullRequest: 31,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe("coordination-pr-target-branch-mismatch");
      expect(result.finalizedTasks).toEqual([]);
      expect(childIssues[0]!.state).toBe("OPEN");
      expect(childIssueMutationCommands(commands)).toEqual([]);
      expect(pullRequest.comments).toHaveLength(1);
      expect(pullRequest.comments[0]!.body).toContain(
        "coordination-pr-target-branch-mismatch",
      );
      expect(pullRequest.comments[0]!.body).toContain(
        "coordination PR base branch main does not match the manifest target branch release",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("reports finalization needs attention and mutates no child issues when an accepted event branch does not match the manifest task branch", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Accepted child task on an old branch",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(23, "sandcastle/task/23-old-branch"),
          ],
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 30,
        url: "https://github.com/Whamp/sandcastle/pull/30",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssues[0]!.title },
            branch: "sandcastle/task/23-finalization-core",
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], childIssues);

      const result = await finalizeIntegration({
        coordinationPullRequest: 30,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe("accepted-task-state-inconsistent");
      expect(result.finalizedTasks).toEqual([]);
      expect(childIssues[0]!.state).toBe("OPEN");
      expect(childIssueMutationCommands(commands)).toEqual([]);
      expect(pullRequest.comments).toHaveLength(1);
      expect(pullRequest.comments[0]!.body).toContain(
        "accepted-task-state-inconsistent",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not treat a stale historical accepted-for-integration event as current when a later lifecycle event contradicts it", async () => {
    const { repo, landedCommit } = await setupMergedRepo();
    try {
      const branch = "sandcastle/task/23-finalization-core";
      const childIssues: FakeIssue[] = [
        {
          number: 23,
          title: "Accepted child task later moved to needs attention",
          body: "## Parent\n\n#21",
          state: "OPEN",
          comments: [
            acceptedForIntegrationComment(23, branch),
            lifecycleComment(
              23,
              "needs-attention",
              "2026-04-24T11:00:00.000Z",
              {
                branch,
                reason: "A later review contradicted the accepted state.",
              },
            ),
          ],
        },
      ];
      const pullRequest: FakePullRequest = {
        number: 36,
        url: "https://github.com/Whamp/sandcastle/pull/36",
        state: "MERGED",
        body: manifestBody([
          {
            task: { id: "#23", title: childIssues[0]!.title },
            branch,
          },
        ]),
        headRefName: "sandcastle/coordinator/21",
        baseRefName: "main",
        mergedAt: "2026-04-24T12:00:00.000Z",
        mergeCommit: { oid: landedCommit },
        comments: [],
      };
      const { gh, commands } = createFakeGh([pullRequest], childIssues);

      const result = await finalizeIntegration({
        coordinationPullRequest: 36,
        repo: "Whamp/sandcastle",
        cwd: repo,
        gh,
      });

      expect(result.outcome).toBe("finalization-needs-attention");
      expect(result.reason).toBe("accepted-task-state-inconsistent");
      expect(childIssues[0]!.state).toBe("OPEN");
      expect(doneEvents(childIssues[0]!)).toEqual([]);
      expect(childIssueMutationCommands(commands)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

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
