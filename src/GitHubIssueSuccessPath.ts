import { randomUUID } from "node:crypto";
import {
  DEFAULT_TASK_CLAIM_LEASE_MS,
  getTaskCoordinationClaimState,
  type GitHubIssue,
  type GitHubIssueTask,
  type TaskCoordinationComment,
} from "./GitHubIssueBacklog.js";

export interface GitHubIssueSuccessPathBacklog {
  selectNextReadyTask(asOf?: Date): Promise<GitHubIssueTask | undefined>;
  getIssue(number: number): Promise<GitHubIssue>;
  claimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  reclaimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  releaseTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  markTaskNeedsAttention(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  markTaskDone(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  closeTask(issueNumber: number): Promise<void>;
}

export interface GitHubIssueTaskRunResult {
  readonly branch: string;
  readonly commits: ReadonlyArray<{ readonly sha: string }>;
}

export interface ExecuteGitHubIssueTaskOptions {
  readonly selectedTask: GitHubIssueTask;
  readonly parentIssue?: GitHubIssue;
}

export interface GitHubIssueSuccessPathOptions {
  readonly backlog: GitHubIssueSuccessPathBacklog;
  readonly executeTask: (
    options: ExecuteGitHubIssueTaskOptions,
  ) => Promise<GitHubIssueTaskRunResult>;
  readonly runId?: string;
  readonly now?: () => Date;
}

export interface GitHubIssueSuccessPathResult {
  readonly selectedTask?: GitHubIssueTask;
  readonly parentIssue?: GitHubIssue;
  readonly runId?: string;
  readonly executionMode: "host";
  readonly runResult?: GitHubIssueTaskRunResult;
  readonly closed: boolean;
}

const createComment = (
  options: Pick<GitHubIssueSuccessPathResult, "runId" | "executionMode"> & {
    readonly event: TaskCoordinationComment["event"];
    readonly now: Date;
    readonly claimLeaseMs?: number;
    readonly branch?: string;
    readonly commits?: string[];
    readonly reason?: string;
    readonly reclaimedClaimRunId?: string;
    readonly reclaimedLeaseExpiresAt?: string;
  },
): TaskCoordinationComment => ({
  kind: "sandcastle-task-coordination",
  version: 1,
  event: options.event,
  runId: options.runId!,
  executionMode: options.executionMode,
  recordedAt: options.now.toISOString(),
  leaseExpiresAt:
    options.event === "claim"
      ? new Date(
          options.now.getTime() +
            (options.claimLeaseMs ?? DEFAULT_TASK_CLAIM_LEASE_MS),
        ).toISOString()
      : undefined,
  branch: options.branch,
  commits: options.commits,
  reason: options.reason,
  reclaimedClaimRunId: options.reclaimedClaimRunId,
  reclaimedLeaseExpiresAt: options.reclaimedLeaseExpiresAt,
});

const getExecutionFailureReason = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  const reason = String(error).trim();
  return reason.length > 0 ? reason : "Unknown execution failure.";
};

export const executeNextGitHubIssueTask = async (
  options: GitHubIssueSuccessPathOptions,
): Promise<GitHubIssueSuccessPathResult> => {
  const executionMode = "host" as const;
  const now = options.now ?? (() => new Date());
  const selectionTime = now();
  const selectedTask = await options.backlog.selectNextReadyTask(selectionTime);

  if (!selectedTask) {
    return {
      executionMode,
      closed: false,
    };
  }

  const runId = options.runId ?? `sandcastle-${randomUUID()}`;
  const parentIssue = selectedTask.parentIssueNumber
    ? await options.backlog.getIssue(selectedTask.parentIssueNumber)
    : undefined;
  const claimState = getTaskCoordinationClaimState(
    selectedTask.issue.comments,
    {
      now: selectionTime,
      defaultLeaseMs: DEFAULT_TASK_CLAIM_LEASE_MS,
    },
  );

  if (claimState.status === "stale") {
    await options.backlog.reclaimTask(
      selectedTask.issue.number,
      createComment({
        event: "reclaim",
        runId,
        executionMode,
        now: now(),
        reason: "The prior claim lease expired before selection.",
        reclaimedClaimRunId: claimState.claim?.runId,
        reclaimedLeaseExpiresAt: claimState.leaseExpiresAt,
      }),
    );
  }

  await options.backlog.claimTask(
    selectedTask.issue.number,
    createComment({
      event: "claim",
      runId,
      executionMode,
      now: now(),
      claimLeaseMs: DEFAULT_TASK_CLAIM_LEASE_MS,
    }),
  );

  let runResult: GitHubIssueTaskRunResult;
  try {
    runResult = await options.executeTask({ selectedTask, parentIssue });
  } catch (error) {
    await options.backlog.markTaskNeedsAttention(
      selectedTask.issue.number,
      createComment({
        event: "needs-attention",
        runId,
        executionMode,
        now: now(),
        reason: getExecutionFailureReason(error),
      }),
    );
    throw error;
  }

  if (runResult.commits.length === 0) {
    await options.backlog.releaseTask(
      selectedTask.issue.number,
      createComment({
        event: "release",
        runId,
        executionMode,
        now: now(),
        branch: runResult.branch,
        reason: "Run finished without a landed change.",
      }),
    );

    return {
      selectedTask,
      parentIssue,
      runId,
      executionMode,
      runResult,
      closed: false,
    };
  }

  await options.backlog.markTaskDone(
    selectedTask.issue.number,
    createComment({
      event: "done",
      runId,
      executionMode,
      now: now(),
      branch: runResult.branch,
      commits: runResult.commits.map((commit) => commit.sha),
    }),
  );
  await options.backlog.closeTask(selectedTask.issue.number);

  return {
    selectedTask,
    parentIssue,
    runId,
    executionMode,
    runResult,
    closed: true,
  };
};
