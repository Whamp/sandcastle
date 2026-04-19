import { execFile } from "node:child_process";

export interface GitHubIssueComment {
  readonly body: string;
  readonly createdAt?: string;
  readonly author?: { readonly login: string };
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly comments: GitHubIssueComment[];
  readonly url?: string;
}

export interface GitHubIssueTaskDependency {
  readonly issueNumber: number;
  readonly relationship: "blocked-by";
}

export interface GitHubIssueTask {
  readonly issue: GitHubIssue;
  readonly parentIssueNumber?: number;
  readonly dependencies: readonly GitHubIssueTaskDependency[];
}

export interface GitHubIssueTaskReadiness {
  readonly status: "ready" | "blocked";
  readonly unresolvedDependencies: readonly GitHubIssueTaskDependency[];
}

export type TaskCoordinationCommentEvent =
  | "claim"
  | "reclaim"
  | "release"
  | "needs-attention"
  | "done";

export interface TaskCoordinationComment {
  readonly kind: "sandcastle-task-coordination";
  readonly version: 1;
  readonly event: TaskCoordinationCommentEvent;
  readonly runId: string;
  readonly executionMode: "host" | "sandboxed";
  readonly recordedAt: string;
  readonly leaseExpiresAt?: string;
  readonly branch?: string;
  readonly commits?: string[];
  readonly reason?: string;
  readonly reclaimedClaimRunId?: string;
  readonly reclaimedLeaseExpiresAt?: string;
}

export interface TaskCoordinationClaimState {
  readonly status: "unclaimed" | "claimed" | "stale";
  readonly claim?: TaskCoordinationComment;
  readonly leaseExpiresAt?: string;
}

export type GitHubCommandRunner = (args: string[]) => Promise<string>;

export interface GitHubIssueBacklogOptions {
  readonly cwd?: string;
  readonly repo?: string;
  readonly env?: Record<string, string>;
  readonly gh?: GitHubCommandRunner;
}

const execGh = async (
  args: string[],
  options?: Pick<GitHubIssueBacklogOptions, "cwd" | "env">,
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

export const DEFAULT_TASK_CLAIM_LEASE_MS = 4 * 60 * 60 * 1000;

const withRepo = (args: string[], repo?: string): string[] =>
  repo ? [...args, "--repo", repo] : args;

const parseSection = (body: string, heading: string): string | undefined => {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(
      `## ${escapedHeading}\\s*([\\s\\S]*?)(?=\\n##\\s+[^\\n]+|$)`,
      "i",
    ),
  );

  return match?.[1]?.trim();
};

const parseIssueReferences = (text?: string): number[] => {
  if (!text) return [];

  return Array.from(text.matchAll(/#(\d+)/g), (match) => Number(match[1]));
};

const parseExplicitBlockedByIssueReferences = (text?: string): number[] => {
  if (!text) return [];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(
        /^(?:[-*+]\s+|\d+\.\s+)?(?:blocked by\s+)?#(\d+)\s*$/i,
      );

      return match ? [Number(match[1])] : [];
    });
};

export const parseParentIssueNumber = (body: string): number | undefined =>
  parseIssueReferences(parseSection(body, "Parent"))[0];

export const parseBlockedByIssueNumbers = (body: string): number[] =>
  parseExplicitBlockedByIssueReferences(parseSection(body, "Blocked by"));

export const mapGitHubIssueToTask = (issue: GitHubIssue): GitHubIssueTask => ({
  issue,
  parentIssueNumber: parseParentIssueNumber(issue.body),
  dependencies: Array.from(new Set(parseBlockedByIssueNumbers(issue.body))).map(
    (issueNumber) => ({
      issueNumber,
      relationship: "blocked-by" as const,
    }),
  ),
});

export const getGitHubIssueTaskReadiness = (
  task: Pick<GitHubIssueTask, "dependencies">,
  dependencyStates: ReadonlyMap<number, GitHubIssue["state"]>,
): GitHubIssueTaskReadiness => {
  const unresolvedDependencies = task.dependencies.filter(
    (dependency) => dependencyStates.get(dependency.issueNumber) !== "CLOSED",
  );

  return {
    status: unresolvedDependencies.length > 0 ? "blocked" : "ready",
    unresolvedDependencies,
  };
};

export const isPrdIssue = (issue: Pick<GitHubIssue, "title">): boolean =>
  issue.title.trim().toLowerCase().startsWith("prd:");

export const formatTaskCoordinationComment = (
  comment: TaskCoordinationComment,
): string => {
  const headline =
    comment.event === "claim"
      ? "Sandcastle Task Coordination claim"
      : comment.event === "reclaim"
        ? "Sandcastle Task Coordination reclaim"
        : comment.event === "release"
          ? "Sandcastle Task Coordination release"
          : comment.event === "needs-attention"
            ? "Sandcastle Task Coordination needs attention"
            : "Sandcastle Task Coordination done";

  const executionLabel =
    comment.executionMode === "host" ? "host execution" : "sandboxed execution";
  const description =
    comment.event === "claim"
      ? `This GitHub Issue is the selected Task for the current ${executionLabel}. The claim lease expires at ${comment.leaseExpiresAt ?? "an unspecified time"}.`
      : comment.event === "reclaim"
        ? `Sandcastle reclaimed a stale GitHub-backed Task claim lease${comment.reclaimedLeaseExpiresAt ? ` that expired at ${comment.reclaimedLeaseExpiresAt}` : ""} so Task Coordination can select the Task again.`
        : comment.event === "release"
          ? "This GitHub Issue Task claim has been released."
          : comment.event === "needs-attention"
            ? `This GitHub-backed Task needs attention rather than dependency-blocked treatment because ${executionLabel} failed in a way that requires intervention beyond ordinary retry.${comment.reason ? ` Reason: ${comment.reason}` : ""}`
            : "This GitHub Issue Task has landed through Task Coordination and is ready for closure.";

  return `${headline}\n\n${description}\n\n\`\`\`json\n${JSON.stringify(comment, null, 2)}\n\`\`\``;
};

export const parseTaskCoordinationComment = (
  body: string,
): TaskCoordinationComment | undefined => {
  if (!body.includes("sandcastle-task-coordination")) {
    return undefined;
  }

  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]!) as Partial<TaskCoordinationComment>;
    if (
      parsed.kind !== "sandcastle-task-coordination" ||
      parsed.version !== 1 ||
      (parsed.event !== "claim" &&
        parsed.event !== "reclaim" &&
        parsed.event !== "release" &&
        parsed.event !== "needs-attention" &&
        parsed.event !== "done") ||
      (parsed.executionMode !== "host" &&
        parsed.executionMode !== "sandboxed") ||
      typeof parsed.runId !== "string" ||
      typeof parsed.recordedAt !== "string" ||
      (parsed.leaseExpiresAt !== undefined &&
        typeof parsed.leaseExpiresAt !== "string") ||
      (parsed.branch !== undefined && typeof parsed.branch !== "string") ||
      (parsed.commits !== undefined &&
        (!Array.isArray(parsed.commits) ||
          parsed.commits.some((commit) => typeof commit !== "string"))) ||
      (parsed.reason !== undefined && typeof parsed.reason !== "string") ||
      (parsed.reclaimedClaimRunId !== undefined &&
        typeof parsed.reclaimedClaimRunId !== "string") ||
      (parsed.reclaimedLeaseExpiresAt !== undefined &&
        typeof parsed.reclaimedLeaseExpiresAt !== "string")
    ) {
      return undefined;
    }

    return parsed as TaskCoordinationComment;
  } catch {
    return undefined;
  }
};

const hasRecordedTaskCoordinationEvent = (
  comments: readonly GitHubIssueComment[],
  event: TaskCoordinationCommentEvent,
): boolean =>
  comments.some(
    (comment) => parseTaskCoordinationComment(comment.body)?.event === event,
  );

export const hasRecordedTaskCoordinationDone = (
  comments: readonly GitHubIssueComment[],
): boolean => hasRecordedTaskCoordinationEvent(comments, "done");

export const hasRecordedTaskCoordinationNeedsAttention = (
  comments: readonly GitHubIssueComment[],
): boolean => hasRecordedTaskCoordinationEvent(comments, "needs-attention");

const getLeaseExpiryTimestamp = (
  claim: TaskCoordinationComment,
  createdAt: string | undefined,
  claimLeaseMs: number,
): string | undefined => {
  if (
    claim.leaseExpiresAt !== undefined &&
    !Number.isNaN(Date.parse(claim.leaseExpiresAt))
  ) {
    return new Date(claim.leaseExpiresAt).toISOString();
  }

  const recordedAt = !Number.isNaN(Date.parse(claim.recordedAt))
    ? claim.recordedAt
    : createdAt;
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) {
    return undefined;
  }

  return new Date(Date.parse(recordedAt) + claimLeaseMs).toISOString();
};

export const getTaskCoordinationClaimState = (
  comments: readonly GitHubIssueComment[],
  options: {
    readonly now?: Date;
    readonly defaultLeaseMs?: number;
  } = {},
): TaskCoordinationClaimState => {
  const now = options.now ?? new Date();
  const claimLeaseMs = options.defaultLeaseMs ?? DEFAULT_TASK_CLAIM_LEASE_MS;
  let activeClaim:
    | {
        readonly comment: TaskCoordinationComment;
        readonly createdAt?: string;
      }
    | undefined;

  for (const comment of comments) {
    const parsed = parseTaskCoordinationComment(comment.body);
    if (!parsed) {
      continue;
    }

    if (parsed.event === "claim") {
      activeClaim = {
        comment: parsed,
        createdAt: comment.createdAt,
      };
      continue;
    }

    if (
      parsed.event === "reclaim" ||
      parsed.event === "release" ||
      parsed.event === "needs-attention" ||
      parsed.event === "done"
    ) {
      activeClaim = undefined;
    }
  }

  if (!activeClaim) {
    return { status: "unclaimed" };
  }

  const leaseExpiresAt = getLeaseExpiryTimestamp(
    activeClaim.comment,
    activeClaim.createdAt,
    claimLeaseMs,
  );
  if (
    leaseExpiresAt &&
    !Number.isNaN(now.getTime()) &&
    Date.parse(leaseExpiresAt) <= now.getTime()
  ) {
    return {
      status: "stale",
      claim: activeClaim.comment,
      leaseExpiresAt,
    };
  }

  return {
    status: "claimed",
    claim: activeClaim.comment,
    leaseExpiresAt,
  };
};

export const hasUnresolvedTaskCoordinationClaim = (
  comments: readonly GitHubIssueComment[],
  options: {
    readonly now?: Date;
    readonly defaultLeaseMs?: number;
  } = {},
): boolean =>
  getTaskCoordinationClaimState(comments, options).status === "claimed";

export class GitHubIssueBacklog {
  readonly #cwd?: string;
  readonly #repo?: string;
  readonly #env?: Record<string, string>;
  readonly #gh: GitHubCommandRunner;

  constructor(options: GitHubIssueBacklogOptions = {}) {
    this.#cwd = options.cwd;
    this.#repo = options.repo;
    this.#env = options.env;
    this.#gh =
      options.gh ??
      ((args) =>
        execGh(withRepo(args, this.#repo), {
          cwd: this.#cwd,
          env: this.#env,
        }));
  }

  async listReadyIssues(): Promise<
    Array<Pick<GitHubIssue, "number" | "title">>
  > {
    return JSON.parse(
      await this.#gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "ready-for-agent",
        "--limit",
        "100",
        "--json",
        "number,title",
      ]),
    ) as Array<Pick<GitHubIssue, "number" | "title">>;
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return JSON.parse(
      await this.#gh([
        "issue",
        "view",
        String(number),
        "--json",
        "number,title,body,state,comments,url",
      ]),
    ) as GitHubIssue;
  }

  async selectNextReadyTask(
    asOf: Date = new Date(),
  ): Promise<GitHubIssueTask | undefined> {
    const readyIssues = await this.listReadyIssues();
    const orderedIssueNumbers = readyIssues
      .map((issue) => issue.number)
      .sort((left, right) => left - right);

    for (const issueNumber of orderedIssueNumbers) {
      const issue = await this.getIssue(issueNumber);
      if (isPrdIssue(issue)) {
        continue;
      }

      if (hasRecordedTaskCoordinationDone(issue.comments)) {
        continue;
      }

      if (hasRecordedTaskCoordinationNeedsAttention(issue.comments)) {
        continue;
      }

      if (
        hasUnresolvedTaskCoordinationClaim(issue.comments, {
          now: asOf,
          defaultLeaseMs: DEFAULT_TASK_CLAIM_LEASE_MS,
        })
      ) {
        continue;
      }

      const task = mapGitHubIssueToTask(issue);
      const dependencyStates = new Map<number, GitHubIssue["state"]>(
        await Promise.all(
          task.dependencies.map(async (dependency) =>
            [
              dependency.issueNumber,
              (await this.getIssue(dependency.issueNumber)).state,
            ] as const,
          ),
        ),
      );
      const readiness = getGitHubIssueTaskReadiness(task, dependencyStates);

      if (readiness.status === "blocked") {
        continue;
      }

      return task;
    }

    return undefined;
  }

  async claimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async reclaimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async releaseTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async markTaskNeedsAttention(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async markTaskDone(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async closeTask(issueNumber: number): Promise<void> {
    await this.#gh(["issue", "close", String(issueNumber)]);
  }

  private async commentOnIssue(
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.#gh(["issue", "comment", String(issueNumber), "--body", body]);
  }
}
