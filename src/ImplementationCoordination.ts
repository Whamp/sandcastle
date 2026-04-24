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
}

export interface VerificationResult {
  readonly target?: string;
  readonly passed: boolean;
  readonly summary: string;
}

export interface IntegratedTask {
  readonly task: ScopedTask;
  readonly branch: string;
  readonly workspace?: string;
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
}

export interface ImplementationCoordinationBacklogPort {
  loadParent(parent: ParentRef): Promise<ParentEffort>;
  listScopedTasks(parent: ParentEffort): Promise<readonly ScopedTask[]>;
  claimTask?(task: ScopedTask): Promise<void>;
  markTaskDone?(task: ScopedTask, outcome: DoneOutcome): Promise<void>;
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

export interface ImplementationCoordinationOptions {
  readonly parent: ParentRef;
  readonly ports: ImplementationCoordinationPorts;
}

export interface ImplementationCoordinationResult {
  readonly parent: ParentEffort;
  readonly scopedTasks: readonly ScopedTask[];
  readonly completedTasks: readonly IntegratedTask[];
  readonly coordinatorWorkspace?: CoordinatorWorkspace;
  readonly coordinatorVerification?: VerificationResult;
  readonly pullRequest?: CoordinationPullRequest;
  readonly noPullRequestReason?: string;
  readonly mergeRecommendation: MergeRecommendation;
}

export const NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON =
  "No PR or integration report was created because no issue branch was accepted.";

const hasBlockingFindings = (reviewerResult: ReviewerResult): boolean =>
  reviewerResult.findings.some(
    (finding) => finding.severity === "P0" || finding.severity === "P1",
  );

const requirePort = <TPort>(
  port: TPort | undefined,
  portName: string,
): TPort => {
  if (port === undefined) {
    throw new Error(`${portName} port is required when scoped tasks exist.`);
  }

  return port;
};

const renderPullRequestBody = (options: {
  readonly parent: ParentEffort;
  readonly completedTasks: readonly IntegratedTask[];
  readonly verification: VerificationResult;
  readonly mergeRecommendation: MergeRecommendation;
}): string => {
  const completedTasks = options.completedTasks
    .map((completedTask) => {
      const taskName = completedTask.task.title ?? completedTask.task.id;
      const verificationSummary = completedTask.verification?.summary;
      return `- ${taskName} (${completedTask.task.id}) on ${completedTask.branch}${
        verificationSummary ? ` — ${verificationSummary}` : ""
      }`;
    })
    .join("\n");
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
    "## Verification summary",
    `- Coordinator: ${options.verification.summary}`,
    "",
    "## Merge recommendation",
    recommendation,
  ].join("\n");
};

export const runImplementationCoordination = async (
  options: ImplementationCoordinationOptions,
): Promise<ImplementationCoordinationResult> => {
  const parent = await options.ports.backlog.loadParent(options.parent);
  const scopedTasks = await options.ports.backlog.listScopedTasks(parent);
  const completedTasks: IntegratedTask[] = [];

  if (scopedTasks.length === 0) {
    return {
      parent,
      scopedTasks,
      completedTasks,
      noPullRequestReason: NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON,
      mergeRecommendation: "do-not-recommend-merge-yet",
    };
  }

  const workspace = requirePort(options.ports.workspace, "workspace");
  const agentRunner = requirePort(options.ports.agentRunner, "agentRunner");
  const verifier = requirePort(options.ports.verifier, "verifier");
  const coordinatorWorkspace = await workspace.createCoordinatorWorkspace({
    parent,
  });

  for (const task of scopedTasks) {
    await options.ports.backlog.claimTask?.(task);
    const taskWorkspace = await workspace.createTaskWorkspace({
      parent,
      task,
      coordinatorWorkspace,
    });
    const workerResult = await agentRunner.runWorker({
      parent,
      task,
      taskWorkspace,
    });
    const reviewerResult = await agentRunner.runReviewer({
      parent,
      task,
      taskWorkspace,
      workerResult,
    });

    if (hasBlockingFindings(reviewerResult)) {
      continue;
    }

    const taskVerification = await verifier.verify({
      target: "task",
      parent,
      task,
      taskWorkspace,
      coordinatorWorkspace,
    });
    await workspace.mergeTaskIntoCoordinator({
      task,
      taskWorkspace,
      coordinatorWorkspace,
    });
    await options.ports.backlog.markTaskDone?.(task, {
      acceptance: "accepted",
      branch: taskWorkspace.branch,
      verification: taskVerification,
    });
    completedTasks.push({
      task,
      branch: taskWorkspace.branch,
      workspace: taskWorkspace.path,
      verification: taskVerification,
    });
  }

  if (completedTasks.length === 0) {
    return {
      parent,
      scopedTasks,
      completedTasks,
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
  const mergeRecommendation: MergeRecommendation =
    coordinatorVerification.passed
      ? "recommend-merge"
      : "do-not-recommend-merge-yet";
  const hasIntegratedChanges = await workspace.hasIntegratedChanges({
    coordinatorWorkspace,
    completedTasks,
  });

  if (!hasIntegratedChanges) {
    return {
      parent,
      scopedTasks,
      completedTasks,
      coordinatorWorkspace,
      coordinatorVerification,
      noPullRequestReason:
        "No PR or integration report was created because the coordinator branch has no integrated changes.",
      mergeRecommendation,
    };
  }

  await workspace.pushCoordinatorBranch({ coordinatorWorkspace });
  const body = renderPullRequestBody({
    parent,
    completedTasks,
    verification: coordinatorVerification,
    mergeRecommendation,
  });
  const pullRequest = await options.ports.pullRequests.createOrUpdate({
    parent,
    completedTasks,
    coordinatorWorkspace,
    verification: coordinatorVerification,
    mergeRecommendation,
    body,
  });

  return {
    parent,
    scopedTasks,
    completedTasks,
    coordinatorWorkspace,
    coordinatorVerification,
    pullRequest,
    mergeRecommendation,
  };
};

export const coordinateImplementation = runImplementationCoordination;
