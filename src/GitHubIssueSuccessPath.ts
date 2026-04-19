import { randomUUID } from "node:crypto";
import type {
  GitHubIssue,
  GitHubIssueTask,
  TaskCoordinationComment,
} from "./GitHubIssueBacklog.js";

export interface GitHubIssueSuccessPathBacklog {
  selectNextReadyTask(): Promise<GitHubIssueTask | undefined>;
  getIssue(number: number): Promise<GitHubIssue>;
  claimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void>;
  releaseTask(
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
    readonly branch?: string;
    readonly commits?: string[];
    readonly reason?: string;
  },
): TaskCoordinationComment => ({
  kind: "sandcastle-task-coordination",
  version: 1,
  event: options.event,
  runId: options.runId!,
  executionMode: options.executionMode,
  recordedAt: options.now.toISOString(),
  branch: options.branch,
  commits: options.commits,
  reason: options.reason,
});

export const executeNextGitHubIssueTask = async (
  options: GitHubIssueSuccessPathOptions,
): Promise<GitHubIssueSuccessPathResult> => {
  const executionMode = "host" as const;
  const selectedTask = await options.backlog.selectNextReadyTask();

  if (!selectedTask) {
    return {
      executionMode,
      closed: false,
    };
  }

  const runId = options.runId ?? `sandcastle-${randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const parentIssue = selectedTask.parentIssueNumber
    ? await options.backlog.getIssue(selectedTask.parentIssueNumber)
    : undefined;

  await options.backlog.claimTask(
    selectedTask.issue.number,
    createComment({
      event: "claim",
      runId,
      executionMode,
      now: now(),
    }),
  );

  const runResult = await options.executeTask({ selectedTask, parentIssue });
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
