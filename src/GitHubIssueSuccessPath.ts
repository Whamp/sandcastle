import { randomUUID } from "node:crypto";
import {
  DEFAULT_TASK_CLAIM_LEASE_MS,
  getTaskCoordinationClaimState,
  type GitHubIssue,
  type GitHubIssueBlockingPrerequisite,
  type GitHubIssueProposedFollowOn,
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
  createProposedFollowOnTask(options: {
    readonly currentTask: GitHubIssueTask;
    readonly followOn: GitHubIssueProposedFollowOn;
  }): Promise<GitHubIssueTask>;
  createBlockingPrerequisiteTask(options: {
    readonly currentTask: GitHubIssueTask;
    readonly prerequisite: GitHubIssueBlockingPrerequisite;
  }): Promise<GitHubIssueTask>;
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
  readonly stdout?: string;
  readonly proposedFollowOn?: GitHubIssueProposedFollowOn;
  readonly blockedByPrerequisite?: GitHubIssueBlockingPrerequisite;
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
  readonly proposedFollowOnTask?: GitHubIssueTask;
  readonly proposedFollowOnError?: string;
  readonly blockingPrerequisiteTask?: GitHubIssueTask;
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

export const TASK_COORDINATION_RESULT_TAG =
  "sandcastle-task-coordination-result";

const hasConcreteProposedFollowOn = (
  proposedFollowOn: GitHubIssueProposedFollowOn,
): boolean =>
  proposedFollowOn.title.trim().length > 0 &&
  proposedFollowOn.body.trim().length > 0;

const hasConcreteBlockingPrerequisite = (
  blockedByPrerequisite: GitHubIssueBlockingPrerequisite,
): boolean =>
  blockedByPrerequisite.title.trim().length > 0 &&
  blockedByPrerequisite.body.trim().length > 0;

const parseTaskCoordinationResultPayload = (
  stdout: string | undefined,
):
  | Partial<{
      proposedFollowOn: GitHubIssueProposedFollowOn;
      blockedByPrerequisite: GitHubIssueBlockingPrerequisite;
    }>
  | undefined => {
  if (!stdout) {
    return undefined;
  }

  const matches = Array.from(
    stdout.matchAll(
      new RegExp(
        `<${TASK_COORDINATION_RESULT_TAG}>\\s*([\\s\\S]*?)\\s*</${TASK_COORDINATION_RESULT_TAG}>`,
        "gi",
      ),
    ),
  );
  const payload = matches.at(-1)?.[1]?.trim();

  if (!payload) {
    return undefined;
  }

  try {
    return JSON.parse(payload) as Partial<{
      proposedFollowOn: GitHubIssueProposedFollowOn;
      blockedByPrerequisite: GitHubIssueBlockingPrerequisite;
    }>;
  } catch {
    return undefined;
  }
};

const parseTaskCoordinationProposedFollowOnResult = (
  stdout: string | undefined,
): GitHubIssueProposedFollowOn | undefined => {
  const parsed = parseTaskCoordinationResultPayload(stdout);

  if (
    typeof parsed?.proposedFollowOn?.title !== "string" ||
    typeof parsed.proposedFollowOn?.body !== "string"
  ) {
    return undefined;
  }

  return {
    title: parsed.proposedFollowOn.title.trim(),
    body: parsed.proposedFollowOn.body.trim(),
  };
};

const parseTaskCoordinationBlockedByPrerequisiteResult = (
  stdout: string | undefined,
): GitHubIssueBlockingPrerequisite | undefined => {
  const parsed = parseTaskCoordinationResultPayload(stdout);

  if (
    typeof parsed?.blockedByPrerequisite?.title !== "string" ||
    typeof parsed.blockedByPrerequisite?.body !== "string"
  ) {
    return undefined;
  }

  return {
    title: parsed.blockedByPrerequisite.title.trim(),
    body: parsed.blockedByPrerequisite.body.trim(),
  };
};

const normalizeGitHubIssueTaskRunResult = (
  runResult: GitHubIssueTaskRunResult,
): GitHubIssueTaskRunResult => {
  const proposedFollowOn = runResult.proposedFollowOn
    ? {
        title: runResult.proposedFollowOn.title.trim(),
        body: runResult.proposedFollowOn.body.trim(),
      }
    : parseTaskCoordinationProposedFollowOnResult(runResult.stdout);
  const blockedByPrerequisite = runResult.blockedByPrerequisite
    ? {
        title: runResult.blockedByPrerequisite.title.trim(),
        body: runResult.blockedByPrerequisite.body.trim(),
      }
    : parseTaskCoordinationBlockedByPrerequisiteResult(runResult.stdout);

  if (!proposedFollowOn && !blockedByPrerequisite) {
    return runResult;
  }

  return {
    ...runResult,
    proposedFollowOn,
    blockedByPrerequisite,
  };
};

const createProposedFollowOnOutcome = async (options: {
  readonly backlog: GitHubIssueSuccessPathBacklog;
  readonly currentTask: GitHubIssueTask;
  readonly proposedFollowOn?: GitHubIssueProposedFollowOn;
}): Promise<
  Pick<
    GitHubIssueSuccessPathResult,
    "proposedFollowOnTask" | "proposedFollowOnError"
  >
> => {
  if (
    !options.proposedFollowOn ||
    !hasConcreteProposedFollowOn(options.proposedFollowOn)
  ) {
    return {};
  }

  try {
    return {
      proposedFollowOnTask: await options.backlog.createProposedFollowOnTask({
        currentTask: options.currentTask,
        followOn: options.proposedFollowOn,
      }),
    };
  } catch (error) {
    return {
      proposedFollowOnError: getExecutionFailureReason(error),
    };
  }
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
    runResult = normalizeGitHubIssueTaskRunResult(
      await options.executeTask({ selectedTask, parentIssue }),
    );
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

  if (
    runResult.commits.length === 0 &&
    runResult.blockedByPrerequisite &&
    hasConcreteBlockingPrerequisite(runResult.blockedByPrerequisite)
  ) {
    const blockingPrerequisiteTask =
      await options.backlog.createBlockingPrerequisiteTask({
        currentTask: selectedTask,
        prerequisite: {
          title: runResult.blockedByPrerequisite.title.trim(),
          body: runResult.blockedByPrerequisite.body.trim(),
        },
      });

    await options.backlog.releaseTask(
      selectedTask.issue.number,
      createComment({
        event: "release",
        runId,
        executionMode,
        now: now(),
        branch: runResult.branch,
        reason: `Discovered blocking prerequisite #${blockingPrerequisiteTask.issue.number}.`,
      }),
    );

    return {
      selectedTask,
      parentIssue,
      blockingPrerequisiteTask,
      runId,
      executionMode,
      runResult,
      closed: false,
    };
  }

  const { proposedFollowOnTask, proposedFollowOnError } =
    await createProposedFollowOnOutcome({
      backlog: options.backlog,
      currentTask: selectedTask,
      proposedFollowOn: runResult.proposedFollowOn,
    });

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
      proposedFollowOnTask,
      proposedFollowOnError,
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
    proposedFollowOnTask,
    proposedFollowOnError,
    runId,
    executionMode,
    runResult,
    closed: true,
  };
};
