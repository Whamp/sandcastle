import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  GitHubIssueBacklog,
  parseTaskCoordinationComment,
  type GitHubCommandRunner,
  type GitHubIssue,
  type GitHubIssueComment,
  type TaskCoordinationComment,
} from "./GitHubIssueBacklog.js";
import {
  runIntegrationFinalization,
  type AcceptedForIntegrationTaskState,
  type IntegrationFinalizationBacklogPort,
  type IntegrationFinalizationCoordinationPullRequest,
  type IntegrationFinalizationCoordinationPullRequestComment,
  type IntegrationFinalizationCoordinationPullRequestPort,
  type IntegrationFinalizationLandingProofPort,
  type IntegrationFinalizationPullRequestRef,
  type IntegrationFinalizationReport,
  type IntegrationFinalizationReporterPort,
  type IntegrationFinalizationResult,
  type TargetBranchLandingProofOptions,
} from "./IntegrationFinalization.js";

export type GitHubIntegrationFinalizationPullRequestInput =
  | number
  | string
  | IntegrationFinalizationPullRequestRef;

export interface GitHubIntegrationFinalizationAdapterOptions {
  readonly cwd?: string;
  readonly repo?: string;
  readonly env?: Record<string, string>;
  readonly gh?: GitHubCommandRunner;
  readonly reportPullRequest?: IntegrationFinalizationPullRequestRef;
}

export interface GitHubIntegrationFinalizationOptions extends GitHubIntegrationFinalizationAdapterOptions {
  readonly coordinationPullRequest: GitHubIntegrationFinalizationPullRequestInput;
}

interface GitHubPullRequestView {
  readonly number: number;
  readonly url?: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED" | string;
  readonly mergedAt?: string | null;
  readonly mergeCommit?: { readonly oid?: string } | null;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly body?: string;
  readonly comments?: readonly IntegrationFinalizationCoordinationPullRequestComment[];
}

const GITHUB_PR_VIEW_FIELDS =
  "number,url,state,mergedAt,mergeCommit,headRefName,baseRefName,body,comments";

const execGh = async (
  args: string[],
  options?: Pick<GitHubIntegrationFinalizationOptions, "cwd" | "env">,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        resolve(stdout.toString());
      },
    );
  });

const execGit = async (
  args: string[],
  options?: Pick<GitHubIntegrationFinalizationOptions, "cwd" | "env">,
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });

const isPullRequestUrlCommand = (args: readonly string[]): boolean =>
  args[0] === "pr" &&
  (args[1] === "view" || args[1] === "comment") &&
  typeof args[2] === "string" &&
  /^https?:\/\//.test(args[2]);

const withRepo = (args: string[], repo?: string): string[] =>
  repo && !isPullRequestUrlCommand(args) ? [...args, "--repo", repo] : args;

const toPullRequestRef = (
  input: GitHubIntegrationFinalizationPullRequestInput,
): IntegrationFinalizationPullRequestRef => {
  if (typeof input === "number") {
    return { number: input };
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^https?:\/\//.test(trimmed)) {
      return { url: trimmed };
    }
    const number = Number(trimmed);
    if (Number.isInteger(number) && number > 0) {
      return { number };
    }
    throw new Error(
      "coordinationPullRequest must be a pull request number, numeric string, URL, or ref object.",
    );
  }

  return input;
};

const pullRequestRefForGh = (
  ref: IntegrationFinalizationPullRequestRef,
): string => {
  if (ref.url) return ref.url;
  if (ref.number !== undefined) return String(ref.number);
  if (ref.id) return ref.id;
  throw new Error(
    "coordinationPullRequest must include a pull request number, URL, or id.",
  );
};

const formatIntegrationFinalizationReportComment = (
  report: IntegrationFinalizationReport,
): string => {
  const headline =
    report.outcome === "pending"
      ? "Integration Finalization pending"
      : report.outcome === "finalization-needs-attention"
        ? "Integration Finalization needs attention"
        : report.outcome === "already-finalized"
          ? "Integration Finalization already finalized"
          : report.outcome === "retry-needed"
            ? "Integration Finalization retry needed"
            : "Integration Finalization finalized";

  return [
    `## ${headline}`,
    "",
    report.summary,
    "",
    "This finalization report is attached to the coordination PR. Finalization needs attention is not a needs-attention Task outcome for child Tasks.",
    "",
    "```json",
    JSON.stringify(
      {
        kind: "sandcastle-integration-finalization-report",
        version: 1,
        outcome: report.outcome,
        reason: report.reason,
        coordinationPullRequest: report.coordinationPullRequest,
        targetBranch: report.targetBranch,
        landedCommit: report.landedCommit,
        acceptedTasks: report.acceptedTasks,
        finalizedTasks: report.finalizedTasks,
        alreadyFinalizedTasks: report.alreadyFinalizedTasks,
        newlyFinalizedTasks: report.newlyFinalizedTasks,
        incompleteTasks: report.incompleteTasks,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
};

export class GitHubIntegrationFinalizationPullRequestAdapter implements IntegrationFinalizationCoordinationPullRequestPort {
  readonly #gh: GitHubCommandRunner;

  constructor(options: GitHubIntegrationFinalizationAdapterOptions = {}) {
    this.#gh =
      options.gh ??
      ((args) =>
        execGh(withRepo(args, options.repo), {
          cwd: options.cwd,
          env: options.env,
        }));
  }

  async load(
    ref: IntegrationFinalizationPullRequestRef,
  ): Promise<IntegrationFinalizationCoordinationPullRequest> {
    const pullRequest = JSON.parse(
      await this.#gh([
        "pr",
        "view",
        pullRequestRefForGh(ref),
        "--json",
        GITHUB_PR_VIEW_FIELDS,
      ]),
    ) as GitHubPullRequestView;

    const merged =
      Boolean(pullRequest.mergedAt) || pullRequest.state === "MERGED";

    return {
      id: String(pullRequest.number),
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state === "OPEN" ? "open" : "closed",
      merged,
      body: pullRequest.body,
      landedCommit: pullRequest.mergeCommit?.oid,
      headBranch: pullRequest.headRefName,
      baseBranch: pullRequest.baseRefName,
      comments: pullRequest.comments ?? [],
    };
  }
}

export class GitHubIntegrationFinalizationReporterAdapter implements IntegrationFinalizationReporterPort {
  readonly #gh: GitHubCommandRunner;
  readonly #reportPullRequest?: IntegrationFinalizationPullRequestRef;

  constructor(options: GitHubIntegrationFinalizationAdapterOptions = {}) {
    this.#reportPullRequest = options.reportPullRequest;
    this.#gh =
      options.gh ??
      ((args) =>
        execGh(withRepo(args, options.repo), {
          cwd: options.cwd,
          env: options.env,
        }));
  }

  async report(report: IntegrationFinalizationReport): Promise<void> {
    await this.#gh([
      "pr",
      "comment",
      pullRequestRefForGh(
        this.#reportPullRequest ?? report.coordinationPullRequest,
      ),
      "--body",
      formatIntegrationFinalizationReportComment(report),
    ]);
  }
}

export class GitHubIntegrationFinalizationLandingProofAdapter implements IntegrationFinalizationLandingProofPort {
  readonly #cwd?: string;
  readonly #env?: Record<string, string>;

  constructor(options: GitHubIntegrationFinalizationAdapterOptions = {}) {
    this.#cwd = options.cwd;
    this.#env = options.env;
  }

  async prove({ targetBranch, landedCommit }: TargetBranchLandingProofOptions) {
    try {
      await execGit(
        ["merge-base", "--is-ancestor", landedCommit, targetBranch],
        {
          cwd: this.#cwd,
          env: this.#env,
        },
      );

      return {
        passed: true,
        summary: `GitHub target-branch landing proof passed: ${landedCommit} is an ancestor of ${targetBranch}.`,
      };
    } catch (error) {
      return {
        passed: false,
        summary: `Integration Finalization needs attention because GitHub target-branch landing proof failed: ${landedCommit} is not an ancestor of ${targetBranch}.${error instanceof Error && error.message ? ` ${error.message}` : ""}`,
      };
    }
  }
}

const commentCreatedAtTimestamp = (comment: GitHubIssueComment): number => {
  const createdAt = comment.createdAt
    ? Date.parse(comment.createdAt)
    : Number.NaN;
  return Number.isNaN(createdAt) ? Number.NaN : createdAt;
};

const getCurrentTaskCoordinationEvent = (
  comments: readonly GitHubIssueComment[],
): TaskCoordinationComment | undefined =>
  comments
    .map((comment, index) => {
      const parsed = parseTaskCoordinationComment(comment.body);
      return parsed
        ? {
            parsed,
            index,
            createdAt: commentCreatedAtTimestamp(comment),
          }
        : undefined;
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly parsed: TaskCoordinationComment;
        readonly index: number;
        readonly createdAt: number;
      } => entry !== undefined,
    )
    .sort((left, right) => {
      if (!Number.isNaN(left.createdAt) && !Number.isNaN(right.createdAt)) {
        return left.createdAt - right.createdAt || left.index - right.index;
      }

      return left.index - right.index;
    })
    .at(-1)?.parsed;

const isCurrentAcceptedForIntegrationEventMatchingManifestTask = (
  comments: readonly GitHubIssueComment[],
  task: Parameters<IntegrationFinalizationBacklogPort["loadTaskState"]>[0],
): boolean => {
  const current = getCurrentTaskCoordinationEvent(comments);
  return (
    current?.event === "accepted-for-integration" &&
    current.branch === task.branch
  );
};

const hasCurrentDoneEventMatchingFinalization = (
  comments: readonly GitHubIssueComment[],
  task: Parameters<IntegrationFinalizationBacklogPort["loadTaskState"]>[0],
  outcome: Parameters<IntegrationFinalizationBacklogPort["loadTaskState"]>[1],
): boolean => {
  const current = getCurrentTaskCoordinationEvent(comments);
  return (
    current?.event === "done" &&
    current.branch === task.branch &&
    current.commits?.includes(outcome.landedCommit) === true
  );
};

const parseAcceptedTaskIssueNumber = (task: {
  readonly id: string;
  readonly issueNumber?: number;
}): number => {
  if (task.issueNumber !== undefined) return task.issueNumber;

  const match =
    task.id.match(/^#?(\d+)$/) ?? task.id.match(/github-issue:(\d+)$/);
  const issueNumber = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(issueNumber)) {
    throw new Error(
      `Accepted child task id must reference a GitHub issue number: ${task.id}`,
    );
  }

  return issueNumber;
};

export class GitHubIntegrationFinalizationBacklogAdapter implements IntegrationFinalizationBacklogPort {
  readonly #backlog: GitHubIssueBacklog;
  readonly #loadedIssues = new Map<number, GitHubIssue>();

  constructor(options: GitHubIntegrationFinalizationAdapterOptions = {}) {
    this.#backlog = new GitHubIssueBacklog(options);
  }

  async loadTaskState(
    task: Parameters<IntegrationFinalizationBacklogPort["loadTaskState"]>[0],
    outcome: Parameters<IntegrationFinalizationBacklogPort["loadTaskState"]>[1],
  ): Promise<AcceptedForIntegrationTaskState> {
    const issueNumber = parseAcceptedTaskIssueNumber(task);
    const issue = await this.#backlog.getIssue(issueNumber);
    this.#loadedIssues.set(issueNumber, issue);

    if (
      hasCurrentDoneEventMatchingFinalization(issue.comments, task, outcome)
    ) {
      return {
        state: "done",
        issueState: issue.state === "CLOSED" ? "closed" : "open",
      };
    }

    if (
      isCurrentAcceptedForIntegrationEventMatchingManifestTask(
        issue.comments,
        task,
      )
    ) {
      return { state: "accepted-for-integration" };
    }

    return { state: "other" };
  }

  async markTaskDone(
    task: Parameters<IntegrationFinalizationBacklogPort["markTaskDone"]>[0],
    outcome: Parameters<IntegrationFinalizationBacklogPort["markTaskDone"]>[1],
  ): Promise<void> {
    const issueNumber = parseAcceptedTaskIssueNumber(task);
    const comment: TaskCoordinationComment = {
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "done",
      runId: `sandcastle-finalization-${randomUUID()}`,
      executionMode: "host",
      recordedAt: new Date().toISOString(),
      branch: outcome.branch,
      commits: [outcome.landedCommit],
      reason: outcome.summary,
    };

    const issue =
      this.#loadedIssues.get(issueNumber) ??
      (await this.#backlog.getIssue(issueNumber));

    if (
      !hasCurrentDoneEventMatchingFinalization(issue.comments, task, outcome)
    ) {
      await this.#backlog.markTaskDone(issueNumber, comment);
    }

    if (issue.state !== "CLOSED") {
      await this.#backlog.closeTask(issueNumber);
    }
  }
}

export const finalizeIntegration = async (
  options: GitHubIntegrationFinalizationOptions,
): Promise<IntegrationFinalizationResult> => {
  const coordinationPullRequest = toPullRequestRef(
    options.coordinationPullRequest,
  );
  const gh = (args: string[]) =>
    options.gh
      ? options.gh(withRepo(args, options.repo))
      : execGh(withRepo(args, options.repo), {
          cwd: options.cwd,
          env: options.env,
        });
  const adapterOptions = {
    ...options,
    gh,
    reportPullRequest: coordinationPullRequest,
  };

  return runIntegrationFinalization({
    coordinationPullRequest,
    ports: {
      coordinationPullRequests:
        new GitHubIntegrationFinalizationPullRequestAdapter(adapterOptions),
      landingProof: new GitHubIntegrationFinalizationLandingProofAdapter(
        adapterOptions,
      ),
      backlog: new GitHubIntegrationFinalizationBacklogAdapter(adapterOptions),
      reporter: new GitHubIntegrationFinalizationReporterAdapter(
        adapterOptions,
      ),
    },
  });
};
