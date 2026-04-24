import type {
  CreateOrUpdateCoordinationPullRequestOptions,
  ParentEffort,
  ReviewFinding,
  VerificationResult,
} from "./ImplementationCoordination.js";

const renderParent = (parent: ParentEffort): string =>
  parent.title ? `${parent.title} (${parent.id})` : parent.id;

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

const renderVerification = (verification?: VerificationResult): string => {
  if (!verification) {
    return "- Not run or not reported";
  }

  const lines = [
    `- ${verification.target ?? "coordinator"}: ${verification.passed ? "passed" : "failed"} — ${verification.summary}`,
  ];

  for (const command of verification.commands ?? []) {
    lines.push(`  - \`${command.command}\`: exit ${command.exitCode}`);
  }

  return lines.join("\n");
};

export const renderImplementationCoordinationReport = (
  options: Omit<CreateOrUpdateCoordinationPullRequestOptions, "body">,
): string => {
  const acceptedForIntegrationTasks = options.acceptedForIntegrationTasks.length
    ? options.acceptedForIntegrationTasks
        .map((acceptedForIntegrationTask) => {
          const taskName =
            acceptedForIntegrationTask.task.title ??
            acceptedForIntegrationTask.task.id;
          const verificationSummary =
            acceptedForIntegrationTask.verification?.summary;
          return `- ${taskName} (${acceptedForIntegrationTask.task.id}) on ${acceptedForIntegrationTask.branch}${verificationSummary ? ` — ${verificationSummary}` : ""}`;
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
            `- ${task.task.title ?? task.task.id} (${task.task.id}): ${task.reason}${task.summary ? ` — ${task.summary}` : ""}${task.branch ? `; branch ${task.branch}` : ""}`,
        )
        .join("\n")
    : "- None";
  const recommendation =
    options.mergeRecommendation === "recommend-merge"
      ? "**Recommend merge**"
      : "**Do not recommend merge yet**";

  return [
    `# Implementation coordination report: ${options.parent.title ?? options.parent.id}`,
    "",
    "## Parent issue/spec",
    `- ${renderParent(options.parent)}`,
    "",
    "## Accepted for integration tasks",
    acceptedForIntegrationTasks,
    "",
    "## Blocked tasks",
    blockedTasks,
    "",
    "## Needs-attention tasks",
    needsAttentionTasks,
    "",
    "## Verification summary",
    renderVerification(options.verification),
    "",
    "## P2/P3 reviewer findings",
    renderFindings(options.nonBlockingReviewFindings),
    "",
    "## Merge recommendation",
    recommendation,
  ].join("\n");
};
