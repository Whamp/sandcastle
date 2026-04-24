import {
  parseCoordinationManifestFromBody,
  type CoordinationManifestAcceptedTask,
} from "./CoordinationManifest.js";

export interface IntegrationFinalizationPullRequestRef {
  readonly id?: string;
  readonly number?: number;
  readonly url?: string;
}

export interface IntegrationFinalizationCoordinationPullRequest {
  readonly id?: string;
  readonly url?: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly body?: string;
  readonly landedCommit?: string;
}

export interface IntegrationFinalizationCoordinationPullRequestPort {
  load(
    ref: IntegrationFinalizationPullRequestRef,
  ): Promise<IntegrationFinalizationCoordinationPullRequest>;
}

export interface TargetBranchLandingProofOptions {
  readonly targetBranch: string;
  readonly landedCommit: string;
}

export interface TargetBranchLandingProofResult {
  readonly passed: boolean;
  readonly summary: string;
}

export interface IntegrationFinalizationLandingProofPort {
  prove(
    options: TargetBranchLandingProofOptions,
  ): Promise<TargetBranchLandingProofResult>;
}

export interface AcceptedForIntegrationTaskState {
  readonly state: "accepted-for-integration" | "done" | "other";
}

export interface MarkDoneOutcome {
  readonly branch: string;
  readonly targetBranch: string;
  readonly landedCommit: string;
  readonly summary: string;
}

export interface IntegrationFinalizationBacklogPort {
  loadTaskState(
    task: CoordinationManifestAcceptedTask,
  ): Promise<AcceptedForIntegrationTaskState>;
  markTaskDone(
    task: CoordinationManifestAcceptedTask,
    outcome: MarkDoneOutcome,
  ): Promise<void>;
}

export type IntegrationFinalizationOutcome =
  | "pending"
  | "finalization-needs-attention"
  | "finalized";

export type IntegrationFinalizationReason =
  | "coordination-pr-open"
  | "coordination-pr-closed-unmerged"
  | "coordination-manifest-missing"
  | "coordination-manifest-invalid"
  | "target-branch-landing-proof-failed"
  | "accepted-task-state-inconsistent"
  | "finalized";

export interface IntegrationFinalizationReport {
  readonly outcome: IntegrationFinalizationOutcome;
  readonly reason: IntegrationFinalizationReason;
  readonly summary: string;
}

const reportAndReturnNeedsAttention = async (
  ports: IntegrationFinalizationPorts,
  reason: Exclude<
    IntegrationFinalizationReason,
    "coordination-pr-open" | "finalized"
  >,
  summary: string,
): Promise<IntegrationFinalizationResult> => {
  await ports.reporter.report({
    outcome: "finalization-needs-attention",
    reason,
    summary,
  });
  return {
    outcome: "finalization-needs-attention",
    reason,
    finalizedTasks: [],
  };
};

export interface IntegrationFinalizationReporterPort {
  report(report: IntegrationFinalizationReport): Promise<void>;
}

export interface IntegrationFinalizationPorts {
  readonly coordinationPullRequests: IntegrationFinalizationCoordinationPullRequestPort;
  readonly landingProof: IntegrationFinalizationLandingProofPort;
  readonly backlog: IntegrationFinalizationBacklogPort;
  readonly reporter: IntegrationFinalizationReporterPort;
}

export interface IntegrationFinalizationOptions {
  readonly coordinationPullRequest: IntegrationFinalizationPullRequestRef;
  readonly ports: IntegrationFinalizationPorts;
}

export interface AtomicIntegrationFinalizationDecision {
  readonly kind: "atomic-finalization";
  readonly targetBranch: string;
  readonly landedCommit: string;
  readonly acceptedTasks: readonly CoordinationManifestAcceptedTask[];
}

export interface IntegrationFinalizationResult {
  readonly outcome: IntegrationFinalizationOutcome;
  readonly reason: IntegrationFinalizationReason;
  readonly finalizedTasks: readonly CoordinationManifestAcceptedTask[];
  readonly decision?: AtomicIntegrationFinalizationDecision;
}

export const runIntegrationFinalization = async (
  options: IntegrationFinalizationOptions,
): Promise<IntegrationFinalizationResult> => {
  const coordinationPullRequest =
    await options.ports.coordinationPullRequests.load(
      options.coordinationPullRequest,
    );

  if (coordinationPullRequest.state === "open") {
    await options.ports.reporter.report({
      outcome: "pending",
      reason: "coordination-pr-open",
      summary:
        "Integration Finalization is pending because the coordination PR is still open.",
    });
    return {
      outcome: "pending",
      reason: "coordination-pr-open",
      finalizedTasks: [],
    };
  }

  if (!coordinationPullRequest.merged) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "coordination-pr-closed-unmerged",
      "Integration Finalization needs attention because the coordination PR was closed without merging.",
    );
  }

  let manifest;
  try {
    manifest = parseCoordinationManifestFromBody(
      coordinationPullRequest.body ?? "",
    );
  } catch (error) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "coordination-manifest-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (manifest === undefined) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "coordination-manifest-missing",
      "Integration Finalization needs attention because the coordination PR does not contain a Sandcastle coordination manifest.",
    );
  }

  if (!coordinationPullRequest.landedCommit) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "target-branch-landing-proof-failed",
      "Integration Finalization needs attention because the merged coordination PR did not provide a landed commit to prove on the target branch.",
    );
  }

  const landingProof = await options.ports.landingProof.prove({
    targetBranch: manifest.targetBranch,
    landedCommit: coordinationPullRequest.landedCommit,
  });

  if (!landingProof.passed) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "target-branch-landing-proof-failed",
      landingProof.summary,
    );
  }

  const taskStates = await Promise.all(
    manifest.acceptedTasks.map(async (task) => ({
      task,
      state: await options.ports.backlog.loadTaskState(task),
    })),
  );
  const inconsistentTask = taskStates.find(
    ({ state }) => state.state !== "accepted-for-integration",
  );

  if (inconsistentTask) {
    return reportAndReturnNeedsAttention(
      options.ports,
      "accepted-task-state-inconsistent",
      `Integration Finalization needs attention because accepted task ${inconsistentTask.task.id} is ${inconsistentTask.state.state}, not accepted for integration.`,
    );
  }

  const decision: AtomicIntegrationFinalizationDecision = {
    kind: "atomic-finalization",
    targetBranch: manifest.targetBranch,
    landedCommit: coordinationPullRequest.landedCommit,
    acceptedTasks: manifest.acceptedTasks,
  };

  for (const task of decision.acceptedTasks) {
    await options.ports.backlog.markTaskDone(task, {
      branch: task.branch,
      targetBranch: decision.targetBranch,
      landedCommit: decision.landedCommit,
      summary: `Accepted task landed on ${decision.targetBranch} at ${decision.landedCommit}.`,
    });
  }

  await options.ports.reporter.report({
    outcome: "finalized",
    reason: "finalized",
    summary: `Integration Finalization marked ${decision.acceptedTasks.length} accepted for integration task(s) done after proving ${decision.landedCommit} landed on ${decision.targetBranch}.`,
  });

  return {
    outcome: "finalized",
    reason: "finalized",
    finalizedTasks: decision.acceptedTasks,
    decision,
  };
};
