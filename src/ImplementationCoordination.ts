export interface ParentRef {
  readonly type: string;
  readonly issueNumber?: number;
  readonly id?: string;
}

export interface ParentEffort {
  readonly id: string;
  readonly title?: string;
}

export interface ScopedTask {
  readonly id: string;
  readonly title?: string;
  readonly blockers?: readonly string[];
}

export interface VerificationCommandResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationResult {
  readonly target?: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly commands?: readonly VerificationCommandResult[];
}

export interface IntegratedTask {
  readonly task: ScopedTask;
  readonly branch: string;
  readonly workspace?: string;
  readonly verification?: VerificationResult;
  readonly reviewFindings?: readonly ReviewFinding[];
}

export interface BlockedTaskResult {
  readonly task: ScopedTask;
  readonly blockers: readonly string[];
}

export type NeedsAttentionReason =
  | "worker-failed"
  | "reviewer-output-unparseable"
  | "max-review-rounds-exhausted"
  | "task-verification-failed"
  | "merge-failed";

export interface NeedsAttentionTaskResult {
  readonly task: ScopedTask;
  readonly reason: NeedsAttentionReason;
  readonly summary?: string;
  readonly branch?: string;
  readonly workspace?: string;
  readonly findings?: readonly ReviewFinding[];
  readonly verification?: VerificationResult;
}

export interface CoordinatorWorkspace {
  readonly id?: string;
  readonly path: string;
  readonly branch: string;
}

export interface TaskWorkspace {
  readonly id?: string;
  readonly path: string;
  readonly branch: string;
}

export interface WorkerResult {
  readonly summary: string;
}

export interface ReviewFinding {
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly title: string;
  readonly body?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ReviewerResult {
  readonly findings: readonly ReviewFinding[];
}

export interface MergeResult {
  readonly merged: boolean;
  readonly summary?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly conflictFiles?: readonly string[];
  readonly taskBranch?: string;
  readonly taskWorkspace?: string;
  readonly coordinatorBranch?: string;
  readonly coordinatorWorkspace?: string;
}

export interface CoordinationPullRequest {
  readonly id?: string;
  readonly url: string;
  readonly body?: string;
}

export type MergeRecommendation =
  | "recommend-merge"
  | "do-not-recommend-merge-yet";

export interface DoneOutcome {
  readonly acceptance: "accepted";
  readonly branch: string;
  readonly verification: VerificationResult;
  readonly reviewFindings?: readonly ReviewFinding[];
}

export interface BlockedOutcome {
  readonly blockers: readonly string[];
}

export interface NeedsAttentionOutcome {
  readonly reason: NeedsAttentionReason;
  readonly summary?: string;
  readonly branch?: string;
  readonly workspace?: string;
  readonly findings?: readonly ReviewFinding[];
  readonly verification?: VerificationResult;
}

export interface ImplementationCoordinationBacklogPort {
  loadParent(parent: ParentRef): Promise<ParentEffort>;
  listScopedTasks(parent: ParentEffort): Promise<readonly ScopedTask[]>;
  claimTask?(task: ScopedTask): Promise<void>;
  releaseTask?(task: ScopedTask, reason: string): Promise<void>;
  markTaskDone?(task: ScopedTask, outcome: DoneOutcome): Promise<void>;
  markTaskBlocked?(task: ScopedTask, outcome: BlockedOutcome): Promise<void>;
  markTaskNeedsAttention?(
    task: ScopedTask,
    outcome: NeedsAttentionOutcome,
  ): Promise<void>;
}

export interface CreateCoordinatorWorkspaceOptions {
  readonly parent: ParentEffort;
}

export interface CreateTaskWorkspaceOptions {
  readonly parent: ParentEffort;
  readonly task: ScopedTask;
  readonly coordinatorWorkspace: CoordinatorWorkspace;
}

export interface MergeTaskOptions {
  readonly task: ScopedTask;
  readonly taskWorkspace: TaskWorkspace;
  readonly coordinatorWorkspace: CoordinatorWorkspace;
}

export interface HasIntegratedChangesOptions {
  readonly coordinatorWorkspace: CoordinatorWorkspace;
  readonly completedTasks: readonly IntegratedTask[];
}

export interface PushCoordinatorOptions {
  readonly coordinatorWorkspace: CoordinatorWorkspace;
}

export interface ImplementationCoordinationWorkspacePort {
  createCoordinatorWorkspace(
    options: CreateCoordinatorWorkspaceOptions,
  ): Promise<CoordinatorWorkspace>;
  createTaskWorkspace(
    options: CreateTaskWorkspaceOptions,
  ): Promise<TaskWorkspace>;
  mergeTaskIntoCoordinator(options: MergeTaskOptions): Promise<MergeResult>;
  hasIntegratedChanges(options: HasIntegratedChangesOptions): Promise<boolean>;
  pushCoordinatorBranch(options: PushCoordinatorOptions): Promise<void>;
}

export interface RunWorkerOptions {
  readonly parent: ParentEffort;
  readonly task: ScopedTask;
  readonly taskWorkspace: TaskWorkspace;
  readonly previousReviewFindings?: readonly ReviewFinding[];
}

export interface RunReviewerOptions {
  readonly parent: ParentEffort;
  readonly task: ScopedTask;
  readonly taskWorkspace: TaskWorkspace;
  readonly workerResult: WorkerResult;
}

export interface ImplementationCoordinationAgentRunnerPort {
  runWorker(options: RunWorkerOptions): Promise<WorkerResult>;
  runReviewer(options: RunReviewerOptions): Promise<ReviewerResult>;
}

export interface VerifyOptions {
  readonly target: "task" | "coordinator";
  readonly parent: ParentEffort;
  readonly task?: ScopedTask;
  readonly taskWorkspace?: TaskWorkspace;
  readonly coordinatorWorkspace: CoordinatorWorkspace;
}

export interface VerificationPort {
  verify(options: VerifyOptions): Promise<VerificationResult>;
}

export interface CreateOrUpdateCoordinationPullRequestOptions {
  readonly parent: ParentEffort;
  readonly completedTasks: readonly IntegratedTask[];
  readonly blockedTasks: readonly BlockedTaskResult[];
  readonly needsAttentionTasks: readonly NeedsAttentionTaskResult[];
  readonly nonBlockingReviewFindings: readonly ReviewFinding[];
  readonly coordinatorWorkspace?: CoordinatorWorkspace;
  readonly verification?: VerificationResult;
  readonly mergeRecommendation: MergeRecommendation;
  readonly body: string;
}

export interface ImplementationCoordinationPullRequestPort {
  createOrUpdate(
    options: CreateOrUpdateCoordinationPullRequestOptions,
  ): Promise<CoordinationPullRequest>;
}

export interface ImplementationCoordinationPorts {
  readonly backlog: ImplementationCoordinationBacklogPort;
  readonly workspace?: ImplementationCoordinationWorkspacePort;
  readonly agentRunner?: ImplementationCoordinationAgentRunnerPort;
  readonly verifier?: VerificationPort;
  readonly pullRequests: ImplementationCoordinationPullRequestPort;
}

export interface ImplementationCoordinationPolicy {
  readonly maxReviewRounds?: number;
}

export interface ImplementationCoordinationOptions {
  readonly parent: ParentRef;
  readonly ports: ImplementationCoordinationPorts;
  readonly policy?: ImplementationCoordinationPolicy;
}

export interface ImplementationCoordinationResult {
  readonly parent: ParentEffort;
  readonly scopedTasks: readonly ScopedTask[];
  readonly completedTasks: readonly IntegratedTask[];
  readonly blockedTasks: readonly BlockedTaskResult[];
  readonly needsAttentionTasks: readonly NeedsAttentionTaskResult[];
  readonly nonBlockingReviewFindings: readonly ReviewFinding[];
  readonly coordinatorWorkspace?: CoordinatorWorkspace;
  readonly coordinatorVerification?: VerificationResult;
  readonly pullRequest?: CoordinationPullRequest;
  readonly noPullRequestReason?: string;
  readonly mergeRecommendation: MergeRecommendation;
}

export const NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON =
  "No PR or integration report was created because no issue branch was accepted.";

const BLOCKING_SEVERITIES = new Set(["P0", "P1"]);
const NON_BLOCKING_SEVERITIES = new Set(["P2", "P3"]);
const ALL_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

const isBlockingFinding = (finding: ReviewFinding): boolean =>
  BLOCKING_SEVERITIES.has(finding.severity);

const partitionFindings = (findings: readonly ReviewFinding[]) => ({
  blocking: findings.filter(isBlockingFinding),
  nonBlocking: findings.filter((finding) =>
    NON_BLOCKING_SEVERITIES.has(finding.severity),
  ),
});

const validateReviewerResult = (
  reviewerResult: unknown,
): reviewerResult is ReviewerResult => {
  if (
    typeof reviewerResult !== "object" ||
    reviewerResult === null ||
    !Array.isArray((reviewerResult as { findings?: unknown }).findings)
  ) {
    return false;
  }

  return (reviewerResult as { findings: unknown[] }).findings.every(
    (finding) =>
      typeof finding === "object" &&
      finding !== null &&
      ALL_SEVERITIES.has((finding as { severity?: string }).severity ?? "") &&
      typeof (finding as { title?: unknown }).title === "string",
  );
};

const requirePort = <TPort>(
  port: TPort | undefined,
  portName: string,
): TPort => {
  if (port === undefined) {
    throw new Error(`${portName} port is required when scoped tasks exist.`);
  }

  return port;
};

type RequiredLifecycleBacklogPort = ImplementationCoordinationBacklogPort & {
  claimTask(task: ScopedTask): Promise<void>;
  releaseTask(task: ScopedTask, reason: string): Promise<void>;
  markTaskDone(task: ScopedTask, outcome: DoneOutcome): Promise<void>;
  markTaskBlocked(task: ScopedTask, outcome: BlockedOutcome): Promise<void>;
  markTaskNeedsAttention(
    task: ScopedTask,
    outcome: NeedsAttentionOutcome,
  ): Promise<void>;
};

const requireBacklogLifecycle = (
  backlog: ImplementationCoordinationBacklogPort,
): RequiredLifecycleBacklogPort => {
  if (
    backlog.claimTask === undefined ||
    backlog.releaseTask === undefined ||
    backlog.markTaskDone === undefined ||
    backlog.markTaskBlocked === undefined ||
    backlog.markTaskNeedsAttention === undefined
  ) {
    throw new Error(
      "backlog lifecycle methods claimTask, releaseTask, markTaskDone, markTaskBlocked, and markTaskNeedsAttention are required when scoped tasks exist.",
    );
  }

  return backlog as RequiredLifecycleBacklogPort;
};

const errorSummary = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const renderFindings = (findings: readonly ReviewFinding[]): string =>
  findings.length === 0
    ? "- None"
    : findings
        .map((finding) => {
          const location = finding.file
            ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
            : "";
          return `- ${finding.severity}: ${finding.title}${location}${
            finding.body ? ` — ${finding.body}` : ""
          }`;
        })
        .join("\n");

const renderPullRequestBody = (options: {
  readonly parent: ParentEffort;
  readonly completedTasks: readonly IntegratedTask[];
  readonly blockedTasks: readonly BlockedTaskResult[];
  readonly needsAttentionTasks: readonly NeedsAttentionTaskResult[];
  readonly nonBlockingReviewFindings: readonly ReviewFinding[];
  readonly verification: VerificationResult;
  readonly mergeRecommendation: MergeRecommendation;
}): string => {
  const completedTasks = options.completedTasks.length
    ? options.completedTasks
        .map((completedTask) => {
          const taskName = completedTask.task.title ?? completedTask.task.id;
          const verificationSummary = completedTask.verification?.summary;
          return `- ${taskName} (${completedTask.task.id}) on ${completedTask.branch}${
            verificationSummary ? ` — ${verificationSummary}` : ""
          }`;
        })
        .join("\n")
    : "- None";
  const blockedTasks = options.blockedTasks.length
    ? options.blockedTasks
        .map(
          (blockedTask) =>
            `- ${blockedTask.task.title ?? blockedTask.task.id} (${blockedTask.task.id}) blocked by ${blockedTask.blockers.join(", ")}`,
        )
        .join("\n")
    : "- None";
  const needsAttentionTasks = options.needsAttentionTasks.length
    ? options.needsAttentionTasks
        .map(
          (task) =>
            `- ${task.task.title ?? task.task.id} (${task.task.id}): ${task.reason}${task.summary ? ` — ${task.summary}` : ""}${task.branch ? `; branch ${task.branch}` : ""}${task.workspace ? `; worktree ${task.workspace}` : ""}`,
        )
        .join("\n")
    : "- None";
  const recommendation =
    options.mergeRecommendation === "recommend-merge"
      ? "Recommend merge"
      : "Do not recommend merge yet";

  return [
    `# Implementation coordination report: ${options.parent.title ?? options.parent.id}`,
    "",
    "## Completed tasks",
    completedTasks,
    "",
    "## Blocked tasks",
    blockedTasks,
    "",
    "## Needs-attention tasks",
    needsAttentionTasks,
    "",
    "## Verification summary",
    `- Coordinator: ${options.verification.summary}`,
    "",
    "## Non-blocking reviewer findings",
    renderFindings(options.nonBlockingReviewFindings),
    "",
    "## Merge recommendation",
    recommendation,
  ].join("\n");
};

const buildNeedsAttentionOutcome = (options: {
  readonly task: ScopedTask;
  readonly taskWorkspace?: TaskWorkspace;
  readonly reason: NeedsAttentionReason;
  readonly summary?: string;
  readonly findings?: readonly ReviewFinding[];
  readonly verification?: VerificationResult;
}): NeedsAttentionTaskResult => ({
  task: options.task,
  reason: options.reason,
  summary: options.summary,
  branch: options.taskWorkspace?.branch,
  workspace: options.taskWorkspace?.path,
  findings: options.findings,
  verification: options.verification,
});

export const runImplementationCoordination = async (
  options: ImplementationCoordinationOptions,
): Promise<ImplementationCoordinationResult> => {
  const maxReviewRounds = options.policy?.maxReviewRounds ?? 2;
  if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) {
    throw new Error("policy.maxReviewRounds must be a positive integer.");
  }

  const parent = await options.ports.backlog.loadParent(options.parent);
  const scopedTasks = await options.ports.backlog.listScopedTasks(parent);
  const completedTasks: IntegratedTask[] = [];
  const blockedTasks: BlockedTaskResult[] = [];
  const needsAttentionTasks: NeedsAttentionTaskResult[] = [];
  const nonBlockingReviewFindings: ReviewFinding[] = [];

  const baseResult = {
    parent,
    scopedTasks,
    completedTasks,
    blockedTasks,
    needsAttentionTasks,
    nonBlockingReviewFindings,
  };

  if (scopedTasks.length === 0) {
    return {
      ...baseResult,
      noPullRequestReason: NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON,
      mergeRecommendation: "do-not-recommend-merge-yet",
    };
  }

  const backlog = requireBacklogLifecycle(options.ports.backlog);
  const workspace = requirePort(options.ports.workspace, "workspace");
  const agentRunner = requirePort(options.ports.agentRunner, "agentRunner");
  const verifier = requirePort(options.ports.verifier, "verifier");
  const coordinatorWorkspace = await workspace.createCoordinatorWorkspace({
    parent,
  });

  for (const task of scopedTasks) {
    if (task.blockers !== undefined && task.blockers.length > 0) {
      const blockedTask = { task, blockers: task.blockers };
      blockedTasks.push(blockedTask);
      await backlog.markTaskBlocked(task, { blockers: task.blockers });
      continue;
    }

    await backlog.claimTask(task);
    let taskWorkspace: TaskWorkspace | undefined;

    const markNeedsAttention = async (
      outcome: Omit<NeedsAttentionTaskResult, "task">,
    ) => {
      const needsAttentionTask: NeedsAttentionTaskResult = {
        task,
        ...outcome,
      };
      needsAttentionTasks.push(needsAttentionTask);
      await backlog.markTaskNeedsAttention(task, {
        reason: needsAttentionTask.reason,
        summary: needsAttentionTask.summary,
        branch: needsAttentionTask.branch,
        workspace: needsAttentionTask.workspace,
        findings: needsAttentionTask.findings,
        verification: needsAttentionTask.verification,
      });
      await backlog.releaseTask(task, needsAttentionTask.reason);
    };

    try {
      taskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace,
      });
    } catch (error) {
      await markNeedsAttention({
        reason: "worker-failed",
        summary: errorSummary(error),
      });
      continue;
    }

    let acceptedReviewFindings: ReviewFinding[] = [];
    let previousBlockingFindings: ReviewFinding[] = [];
    let accepted = false;

    for (
      let reviewRound = 1;
      reviewRound <= maxReviewRounds;
      reviewRound += 1
    ) {
      let workerResult: WorkerResult;
      try {
        workerResult = await agentRunner.runWorker({
          parent,
          task,
          taskWorkspace,
          previousReviewFindings:
            previousBlockingFindings.length > 0
              ? previousBlockingFindings
              : undefined,
        });
      } catch (error) {
        await markNeedsAttention(
          buildNeedsAttentionOutcome({
            task,
            taskWorkspace,
            reason: "worker-failed",
            summary: errorSummary(error),
          }),
        );
        break;
      }

      let reviewerResult: ReviewerResult;
      try {
        reviewerResult = await agentRunner.runReviewer({
          parent,
          task,
          taskWorkspace,
          workerResult,
        });
      } catch (error) {
        await markNeedsAttention(
          buildNeedsAttentionOutcome({
            task,
            taskWorkspace,
            reason: "reviewer-output-unparseable",
            summary: errorSummary(error),
          }),
        );
        break;
      }

      if (!validateReviewerResult(reviewerResult)) {
        await markNeedsAttention(
          buildNeedsAttentionOutcome({
            task,
            taskWorkspace,
            reason: "reviewer-output-unparseable",
            summary:
              "Reviewer output did not match the expected structured findings shape.",
          }),
        );
        break;
      }

      const { blocking, nonBlocking } = partitionFindings(
        reviewerResult.findings,
      );
      acceptedReviewFindings = [...acceptedReviewFindings, ...nonBlocking];
      previousBlockingFindings = blocking;

      if (blocking.length === 0) {
        accepted = true;
        break;
      }

      if (reviewRound === maxReviewRounds) {
        await markNeedsAttention(
          buildNeedsAttentionOutcome({
            task,
            taskWorkspace,
            reason: "max-review-rounds-exhausted",
            summary: `Review still had ${blocking.length} blocking finding(s) after ${maxReviewRounds} round(s).`,
            findings: blocking,
          }),
        );
      }
    }

    if (!accepted) {
      continue;
    }

    nonBlockingReviewFindings.push(...acceptedReviewFindings);

    let taskVerification: VerificationResult;
    try {
      taskVerification = await verifier.verify({
        target: "task",
        parent,
        task,
        taskWorkspace,
        coordinatorWorkspace,
      });
    } catch (error) {
      await markNeedsAttention(
        buildNeedsAttentionOutcome({
          task,
          taskWorkspace,
          reason: "task-verification-failed",
          summary: errorSummary(error),
        }),
      );
      continue;
    }
    if (!taskVerification.passed) {
      await markNeedsAttention(
        buildNeedsAttentionOutcome({
          task,
          taskWorkspace,
          reason: "task-verification-failed",
          summary: taskVerification.summary,
          verification: taskVerification,
        }),
      );
      continue;
    }

    let mergeResult: MergeResult;
    try {
      mergeResult = await workspace.mergeTaskIntoCoordinator({
        task,
        taskWorkspace,
        coordinatorWorkspace,
      });
    } catch (error) {
      await markNeedsAttention(
        buildNeedsAttentionOutcome({
          task,
          taskWorkspace,
          reason: "merge-failed",
          summary: errorSummary(error),
        }),
      );
      continue;
    }
    if (!mergeResult.merged) {
      await markNeedsAttention(
        buildNeedsAttentionOutcome({
          task,
          taskWorkspace,
          reason: "merge-failed",
          summary: mergeResult.summary,
        }),
      );
      continue;
    }

    await backlog.markTaskDone(task, {
      acceptance: "accepted",
      branch: taskWorkspace.branch,
      verification: taskVerification,
      reviewFindings: acceptedReviewFindings,
    });
    completedTasks.push({
      task,
      branch: taskWorkspace.branch,
      workspace: taskWorkspace.path,
      verification: taskVerification,
      reviewFindings: acceptedReviewFindings,
    });
  }

  if (completedTasks.length === 0) {
    return {
      ...baseResult,
      coordinatorWorkspace,
      noPullRequestReason: NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON,
      mergeRecommendation: "do-not-recommend-merge-yet",
    };
  }

  const coordinatorVerification = await verifier.verify({
    target: "coordinator",
    parent,
    coordinatorWorkspace,
  });
  const hasIntegratedChanges = await workspace.hasIntegratedChanges({
    coordinatorWorkspace,
    completedTasks,
  });

  if (!hasIntegratedChanges) {
    return {
      ...baseResult,
      coordinatorWorkspace,
      coordinatorVerification,
      noPullRequestReason:
        "No PR or integration report was created because the coordinator branch has no integrated changes.",
      mergeRecommendation: "do-not-recommend-merge-yet",
    };
  }

  const mergeRecommendation: MergeRecommendation =
    coordinatorVerification.passed
      ? "recommend-merge"
      : "do-not-recommend-merge-yet";

  await workspace.pushCoordinatorBranch({ coordinatorWorkspace });
  const body = renderPullRequestBody({
    parent,
    completedTasks,
    blockedTasks,
    needsAttentionTasks,
    nonBlockingReviewFindings,
    verification: coordinatorVerification,
    mergeRecommendation,
  });
  const pullRequest = await options.ports.pullRequests.createOrUpdate({
    parent,
    completedTasks,
    blockedTasks,
    needsAttentionTasks,
    nonBlockingReviewFindings,
    coordinatorWorkspace,
    verification: coordinatorVerification,
    mergeRecommendation,
    body,
  });

  return {
    ...baseResult,
    coordinatorWorkspace,
    coordinatorVerification,
    pullRequest,
    mergeRecommendation,
  };
};

export const coordinateImplementation = runImplementationCoordination;
