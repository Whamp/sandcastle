import {
  parseCoordinationManifestFromBody,
  type CoordinationManifest,
  type CoordinationManifestAcceptedTask,
} from "./CoordinationManifest.js";

export interface IntegrationFinalizationPullRequestRef {
  readonly id?: string;
  readonly number?: number;
  readonly url?: string;
}

export interface IntegrationFinalizationCoordinationPullRequestComment {
  readonly body: string;
  readonly createdAt?: string;
  readonly author?: { readonly login: string };
}

export interface IntegrationFinalizationCoordinationPullRequest {
  readonly id?: string;
  readonly number?: number;
  readonly url?: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly body?: string;
  readonly landedCommit?: string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly comments?: readonly IntegrationFinalizationCoordinationPullRequestComment[];
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
  readonly issueState?: "open" | "closed";
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
    outcome: MarkDoneOutcome,
  ): Promise<AcceptedForIntegrationTaskState>;
  markTaskDone(
    task: CoordinationManifestAcceptedTask,
    outcome: MarkDoneOutcome,
  ): Promise<void>;
}

export type IntegrationFinalizationOutcome =
  | "pending"
  | "finalization-needs-attention"
  | "finalized"
  | "already-finalized"
  | "retry-needed";

export type IntegrationFinalizationReason =
  | "coordination-pr-open"
  | "coordination-pr-closed-unmerged"
  | "coordination-manifest-missing"
  | "coordination-manifest-invalid"
  | "coordination-pr-target-branch-mismatch"
  | "target-branch-landing-proof-failed"
  | "accepted-task-state-inconsistent"
  | "finalized"
  | "already-finalized"
  | "incomplete-write-retry-needed";

export interface IntegrationFinalizationReportCoordinationPullRequest {
  readonly id?: string;
  readonly number?: number;
  readonly url?: string;
}

export interface IntegrationFinalizationReport {
  readonly outcome: IntegrationFinalizationOutcome;
  readonly reason: IntegrationFinalizationReason;
  readonly summary: string;
  readonly coordinationPullRequest: IntegrationFinalizationReportCoordinationPullRequest;
  readonly targetBranch?: string;
  readonly landedCommit?: string;
  readonly acceptedTasks: readonly CoordinationManifestAcceptedTask[];
  readonly finalizedTasks: readonly CoordinationManifestAcceptedTask[];
  readonly alreadyFinalizedTasks?: readonly CoordinationManifestAcceptedTask[];
  readonly newlyFinalizedTasks?: readonly CoordinationManifestAcceptedTask[];
  readonly incompleteTasks?: readonly CoordinationManifestAcceptedTask[];
}

interface IntegrationFinalizationReportFacts {
  readonly coordinationPullRequest: IntegrationFinalizationReportCoordinationPullRequest;
  readonly manifest?: CoordinationManifest;
  readonly landedCommit?: string;
}

const withDefinedFields = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;

const buildCoordinationPullRequestReportRef = (
  requestedRef: IntegrationFinalizationPullRequestRef,
  coordinationPullRequest: IntegrationFinalizationCoordinationPullRequest,
): IntegrationFinalizationReportCoordinationPullRequest =>
  withDefinedFields({
    id: coordinationPullRequest.id ?? requestedRef.id,
    number: coordinationPullRequest.number ?? requestedRef.number,
    url: coordinationPullRequest.url ?? requestedRef.url,
  });

const buildReport = (
  report: Pick<
    IntegrationFinalizationReport,
    | "outcome"
    | "reason"
    | "summary"
    | "finalizedTasks"
    | "alreadyFinalizedTasks"
    | "newlyFinalizedTasks"
    | "incompleteTasks"
  >,
  facts: IntegrationFinalizationReportFacts,
): IntegrationFinalizationReport =>
  withDefinedFields({
    outcome: report.outcome,
    reason: report.reason,
    summary: report.summary,
    coordinationPullRequest: facts.coordinationPullRequest,
    targetBranch: facts.manifest?.targetBranch,
    landedCommit: facts.landedCommit,
    acceptedTasks: facts.manifest?.acceptedTasks ?? [],
    finalizedTasks: report.finalizedTasks,
    alreadyFinalizedTasks: report.alreadyFinalizedTasks,
    newlyFinalizedTasks: report.newlyFinalizedTasks,
    incompleteTasks: report.incompleteTasks,
  });

const parseManifestForReportFacts = (
  coordinationPullRequest: IntegrationFinalizationCoordinationPullRequest,
): CoordinationManifest | undefined => {
  try {
    return parseCoordinationManifestFromBody(
      coordinationPullRequest.body ?? "",
    );
  } catch {
    return undefined;
  }
};

const reportAndReturnNeedsAttention = async (
  ports: IntegrationFinalizationPorts,
  facts: IntegrationFinalizationReportFacts,
  reason: Exclude<
    IntegrationFinalizationReason,
    "coordination-pr-open" | "finalized"
  >,
  summary: string,
): Promise<IntegrationFinalizationResult> => {
  await ports.reporter.report(
    buildReport(
      {
        outcome: "finalization-needs-attention",
        reason,
        summary,
        finalizedTasks: [],
      },
      facts,
    ),
  );
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
  readonly alreadyFinalizedTasks?: readonly CoordinationManifestAcceptedTask[];
  readonly newlyFinalizedTasks?: readonly CoordinationManifestAcceptedTask[];
  readonly incompleteTasks?: readonly CoordinationManifestAcceptedTask[];
  readonly decision?: AtomicIntegrationFinalizationDecision;
}

export const runIntegrationFinalization = async (
  options: IntegrationFinalizationOptions,
): Promise<IntegrationFinalizationResult> => {
  const coordinationPullRequest =
    await options.ports.coordinationPullRequests.load(
      options.coordinationPullRequest,
    );
  const reportFacts: IntegrationFinalizationReportFacts = {
    coordinationPullRequest: buildCoordinationPullRequestReportRef(
      options.coordinationPullRequest,
      coordinationPullRequest,
    ),
    manifest: parseManifestForReportFacts(coordinationPullRequest),
    landedCommit: coordinationPullRequest.landedCommit,
  };

  if (coordinationPullRequest.state === "open") {
    await options.ports.reporter.report(
      buildReport(
        {
          outcome: "pending",
          reason: "coordination-pr-open",
          summary:
            "Integration Finalization is pending because the coordination PR is still open.",
          finalizedTasks: [],
        },
        reportFacts,
      ),
    );
    return {
      outcome: "pending",
      reason: "coordination-pr-open",
      finalizedTasks: [],
    };
  }

  if (!coordinationPullRequest.merged) {
    return reportAndReturnNeedsAttention(
      options.ports,
      reportFacts,
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
      reportFacts,
      "coordination-manifest-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (manifest === undefined) {
    return reportAndReturnNeedsAttention(
      options.ports,
      reportFacts,
      "coordination-manifest-missing",
      "Integration Finalization needs attention because the coordination PR does not contain a Sandcastle coordination manifest.",
    );
  }

  if (
    coordinationPullRequest.baseBranch !== undefined &&
    coordinationPullRequest.baseBranch !== manifest.targetBranch
  ) {
    return reportAndReturnNeedsAttention(
      options.ports,
      { ...reportFacts, manifest },
      "coordination-pr-target-branch-mismatch",
      `Integration Finalization needs attention because the coordination PR base branch ${coordinationPullRequest.baseBranch} does not match the manifest target branch ${manifest.targetBranch}.`,
    );
  }

  if (!coordinationPullRequest.landedCommit) {
    return reportAndReturnNeedsAttention(
      options.ports,
      { ...reportFacts, manifest },
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
      { ...reportFacts, manifest },
      "target-branch-landing-proof-failed",
      landingProof.summary,
    );
  }

  const markDoneOutcomes = new Map(
    manifest.acceptedTasks.map((task) => [
      task.id,
      {
        branch: task.branch,
        targetBranch: manifest.targetBranch,
        landedCommit: coordinationPullRequest.landedCommit!,
        summary: `Accepted task landed on ${manifest.targetBranch} at ${coordinationPullRequest.landedCommit}.`,
      },
    ]),
  );
  const taskStates = await Promise.all(
    manifest.acceptedTasks.map(async (task) => ({
      task,
      state: await options.ports.backlog.loadTaskState(
        task,
        markDoneOutcomes.get(task.id)!,
      ),
    })),
  );
  const inconsistentTask = taskStates.find(
    ({ state }) =>
      state.state !== "accepted-for-integration" && state.state !== "done",
  );

  if (inconsistentTask) {
    return reportAndReturnNeedsAttention(
      options.ports,
      { ...reportFacts, manifest },
      "accepted-task-state-inconsistent",
      `Integration Finalization needs attention because accepted task ${inconsistentTask.task.id} is ${inconsistentTask.state.state}, not accepted for integration or already done for this coordination PR.`,
    );
  }

  const alreadyFinalizedTasks = taskStates
    .filter(
      ({ state }) => state.state === "done" && state.issueState !== "open",
    )
    .map(({ task }) => task);

  if (alreadyFinalizedTasks.length === manifest.acceptedTasks.length) {
    await options.ports.reporter.report(
      buildReport(
        {
          outcome: "already-finalized",
          reason: "already-finalized",
          summary: `Integration Finalization already finalized ${manifest.acceptedTasks.length} accepted for integration task(s) after proving ${coordinationPullRequest.landedCommit} landed on ${manifest.targetBranch}.`,
          finalizedTasks: manifest.acceptedTasks,
          alreadyFinalizedTasks,
          newlyFinalizedTasks: [],
        },
        { ...reportFacts, manifest },
      ),
    );

    return {
      outcome: "already-finalized",
      reason: "already-finalized",
      finalizedTasks: manifest.acceptedTasks,
      alreadyFinalizedTasks,
      newlyFinalizedTasks: [],
    };
  }

  const decision: AtomicIntegrationFinalizationDecision = {
    kind: "atomic-finalization",
    targetBranch: manifest.targetBranch,
    landedCommit: coordinationPullRequest.landedCommit,
    acceptedTasks: manifest.acceptedTasks,
  };

  const tasksNeedingWrites = taskStates
    .filter(
      ({ state }) => state.state !== "done" || state.issueState === "open",
    )
    .map(({ task }) => task);
  const newlyFinalizedTasks: CoordinationManifestAcceptedTask[] = [];
  const incompleteTasks: CoordinationManifestAcceptedTask[] = [];

  for (const task of tasksNeedingWrites) {
    try {
      await options.ports.backlog.markTaskDone(
        task,
        markDoneOutcomes.get(task.id)!,
      );
      newlyFinalizedTasks.push(task);
    } catch {
      incompleteTasks.push(task);
    }
  }

  if (incompleteTasks.length > 0) {
    const finalizedTasks = decision.acceptedTasks.filter(
      (task) =>
        !incompleteTasks.some((incomplete) => incomplete.id === task.id),
    );

    await options.ports.reporter.report(
      buildReport(
        {
          outcome: "retry-needed",
          reason: "incomplete-write-retry-needed",
          summary: `Integration Finalization proved the coordination PR landed on ${decision.targetBranch} at ${decision.landedCommit}, but ${incompleteTasks.length} accepted task write(s) did not complete. Retry finalization to converge remaining child tasks; completed writes were not rolled back.`,
          finalizedTasks,
          alreadyFinalizedTasks,
          newlyFinalizedTasks,
          incompleteTasks,
        },
        { ...reportFacts, manifest },
      ),
    );

    return {
      outcome: "retry-needed",
      reason: "incomplete-write-retry-needed",
      finalizedTasks,
      alreadyFinalizedTasks,
      newlyFinalizedTasks,
      incompleteTasks,
      decision,
    };
  }

  await options.ports.reporter.report(
    buildReport(
      {
        outcome: "finalized",
        reason: "finalized",
        summary: `Integration Finalization marked ${decision.acceptedTasks.length} accepted for integration task(s) done after proving ${decision.landedCommit} landed on ${decision.targetBranch}.`,
        finalizedTasks: decision.acceptedTasks,
        alreadyFinalizedTasks,
        newlyFinalizedTasks,
      },
      { ...reportFacts, manifest },
    ),
  );

  return {
    outcome: "finalized",
    reason: "finalized",
    finalizedTasks: decision.acceptedTasks,
    alreadyFinalizedTasks,
    newlyFinalizedTasks,
    decision,
  };
};
