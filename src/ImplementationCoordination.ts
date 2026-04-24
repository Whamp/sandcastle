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

export interface IntegratedTask {
  readonly task: ScopedTask;
  readonly branch: string;
}

export interface CoordinationPullRequest {
  readonly url: string;
}

export type MergeRecommendation =
  | "recommend-merge"
  | "do-not-recommend-merge-yet";

export interface ImplementationCoordinationBacklogPort {
  loadParent(parent: ParentRef): Promise<ParentEffort>;
  listScopedTasks(parent: ParentEffort): Promise<readonly ScopedTask[]>;
}

export interface CreateOrUpdateCoordinationPullRequestOptions {
  readonly parent: ParentEffort;
  readonly completedTasks: readonly IntegratedTask[];
  readonly mergeRecommendation: MergeRecommendation;
}

export interface ImplementationCoordinationPullRequestPort {
  createOrUpdate(
    options: CreateOrUpdateCoordinationPullRequestOptions,
  ): Promise<CoordinationPullRequest>;
}

export interface ImplementationCoordinationPorts {
  readonly backlog: ImplementationCoordinationBacklogPort;
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
  readonly pullRequest?: CoordinationPullRequest;
  readonly noPullRequestReason?: string;
  readonly mergeRecommendation: MergeRecommendation;
}

export const NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON =
  "No PR or integration report was created because no issue branch was accepted.";

export const runImplementationCoordination = async (
  options: ImplementationCoordinationOptions,
): Promise<ImplementationCoordinationResult> => {
  const parent = await options.ports.backlog.loadParent(options.parent);
  const scopedTasks = await options.ports.backlog.listScopedTasks(parent);
  const completedTasks: IntegratedTask[] = [];

  return {
    parent,
    scopedTasks,
    completedTasks,
    noPullRequestReason: NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON,
    mergeRecommendation: "do-not-recommend-merge-yet",
  };
};

export const coordinateImplementation = runImplementationCoordination;
