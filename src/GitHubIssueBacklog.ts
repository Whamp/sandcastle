import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BlockedOutcome,
  DoneOutcome,
  ImplementationCoordinationBacklogPort,
  NeedsAttentionOutcome,
  ParentEffort,
  ParentRef,
  ScopedTask,
} from "./ImplementationCoordination.js";

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
  readonly labels?: readonly string[];
  readonly url?: string;
}

export interface GitHubIssueTaskDependency {
  readonly issueNumber: number;
  readonly relationship: "blocked-by";
}

export interface GitHubIssueTask {
  readonly issue: GitHubIssue;
  readonly parentIssueNumber?: number;
  readonly followOnFromIssueNumber?: number;
  readonly dependencies: readonly GitHubIssueTaskDependency[];
}

export interface GitHubIssueTaskReadiness {
  readonly status: "ready" | "blocked";
  readonly unresolvedDependencies: readonly GitHubIssueTaskDependency[];
}

export interface GitHubIssueProposedFollowOn {
  readonly title: string;
  readonly body: string;
}

export interface GitHubIssueBlockingPrerequisite {
  readonly title: string;
  readonly body: string;
}

export interface CreateProposedFollowOnTaskOptions {
  readonly currentTask: GitHubIssueTask;
  readonly followOn: GitHubIssueProposedFollowOn;
}

export interface CreateBlockingPrerequisiteTaskOptions {
  readonly currentTask: GitHubIssueTask;
  readonly prerequisite: GitHubIssueBlockingPrerequisite;
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

export interface GitHubImplementationBacklogAdapterOptions extends GitHubIssueBacklogOptions {
  readonly now?: () => Date;
  readonly runId?: () => string;
  readonly executionMode?: TaskCoordinationComment["executionMode"];
  readonly claimLeaseMs?: number;
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
export const READY_FOR_AGENT_LABEL = "ready-for-agent";
export const NEEDS_ATTENTION_LABEL = "needs-attention";
const NEEDS_ATTENTION_LABEL_COLOR = "D93F0B";
const NEEDS_ATTENTION_LABEL_DESCRIPTION =
  "Tasks that require human attention before returning to the ready queue";

const withRepo = (args: string[], repo?: string): string[] =>
  repo ? [...args, "--repo", repo] : args;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseSection = (body: string, heading: string): string | undefined => {
  const match = body.match(
    new RegExp(
      `## ${escapeRegExp(heading)}\\s*([\\s\\S]*?)(?=\\n##\\s+[^\\n]+|$)`,
      "i",
    ),
  );

  return match?.[1]?.trim();
};

const formatSection = (heading: string, content: string): string =>
  `## ${heading}\n\n${content.trim()}`;

const upsertSection = (
  body: string,
  heading: string,
  content: string,
): string => {
  const trimmedBody = body.trim();
  const formattedSection = formatSection(heading, content);
  const sectionPattern = new RegExp(
    `(^|\\n)## ${escapeRegExp(heading)}\\s*[\\s\\S]*?(?=\\n##\\s+[^\\n]+|$)`,
    "i",
  );

  if (!trimmedBody) {
    return formattedSection;
  }

  if (sectionPattern.test(trimmedBody)) {
    return trimmedBody.replace(
      sectionPattern,
      (_match, prefix: string) => `${prefix}${formattedSection}`,
    );
  }

  return `${trimmedBody}\n\n${formattedSection}`;
};

const appendSectionListItem = (
  body: string,
  heading: string,
  item: string,
): string => {
  const normalizedItem = item.trim();
  const existingSection = parseSection(body, heading);

  if (!existingSection) {
    return upsertSection(body, heading, normalizedItem);
  }

  const existingLines = existingSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (existingLines.includes(normalizedItem)) {
    return body.trim();
  }

  return upsertSection(
    body,
    heading,
    `${existingSection.trim()}\n${normalizedItem}`,
  );
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

export const parseFollowOnFromIssueNumber = (
  body: string,
): number | undefined =>
  parseIssueReferences(parseSection(body, "Follow-on from"))[0];

const buildProposedFollowOnIssueBody = (
  options: CreateProposedFollowOnTaskOptions,
): string => {
  const parentSection =
    parseSection(options.currentTask.issue.body, "Parent") ??
    (options.currentTask.parentIssueNumber
      ? `#${options.currentTask.parentIssueNumber}`
      : undefined);
  let body = options.followOn.body.trim();

  if (parentSection) {
    body = upsertSection(body, "Parent", parentSection);
  }

  return upsertSection(
    body,
    "Follow-on from",
    `- Follow-on from #${options.currentTask.issue.number}`,
  );
};

const buildBlockingPrerequisiteIssueBody = (
  options: CreateBlockingPrerequisiteTaskOptions,
): string => {
  const parentSection =
    parseSection(options.currentTask.issue.body, "Parent") ??
    (options.currentTask.parentIssueNumber
      ? `#${options.currentTask.parentIssueNumber}`
      : undefined);
  let body = options.prerequisite.body.trim();

  if (parentSection) {
    body = upsertSection(body, "Parent", parentSection);
  }

  return upsertSection(
    body,
    "Follow-on from",
    `- Follow-on from #${options.currentTask.issue.number}`,
  );
};

const parseCreatedIssueNumber = (output: string): number => {
  const match =
    output.match(/\/issues\/(\d+)(?:\s|$)/) ?? output.match(/#(\d+)\b/);
  const issueNumber = match?.[1] ? Number(match[1]) : Number.NaN;

  if (Number.isNaN(issueNumber)) {
    throw new Error(
      `Unable to parse created issue number from gh output: ${output.trim()}`,
    );
  }

  return issueNumber;
};

export const mapGitHubIssueToTask = (issue: GitHubIssue): GitHubIssueTask => ({
  issue,
  parentIssueNumber: parseParentIssueNumber(issue.body),
  followOnFromIssueNumber: parseFollowOnFromIssueNumber(issue.body),
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
            ? `This GitHub-backed Task has moved from ${READY_FOR_AGENT_LABEL} to ${NEEDS_ATTENTION_LABEL} rather than dependency-blocked treatment because ${executionLabel} failed in a way that requires intervention beyond ordinary retry.${comment.reason ? ` Reason: ${comment.reason}` : ""}`
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

const hasIssueLabel = (
  issue: Pick<GitHubIssue, "labels">,
  label: string,
): boolean => issue.labels?.includes(label) ?? false;

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
        READY_FOR_AGENT_LABEL,
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
        "number,title,body,state,comments,url,labels",
        "--jq",
        "{number: .number, title: .title, body: .body, state: .state, comments: .comments, url: .url, labels: [.labels[].name]}",
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

      if (hasIssueLabel(issue, NEEDS_ATTENTION_LABEL)) {
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
          task.dependencies.map(
            async (dependency) =>
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

  async createProposedFollowOnTask(
    options: CreateProposedFollowOnTaskOptions,
  ): Promise<GitHubIssueTask> {
    const createdIssue = await this.createIssue({
      title: options.followOn.title.trim(),
      body: buildProposedFollowOnIssueBody(options),
    });

    return mapGitHubIssueToTask(createdIssue);
  }

  async createBlockingPrerequisiteTask(
    options: CreateBlockingPrerequisiteTaskOptions,
  ): Promise<GitHubIssueTask> {
    const createdIssue = await this.createIssue({
      title: options.prerequisite.title.trim(),
      body: buildBlockingPrerequisiteIssueBody(options),
      labels: [READY_FOR_AGENT_LABEL],
    });
    const currentIssue = await this.getIssue(options.currentTask.issue.number);
    const nextCurrentBody = appendSectionListItem(
      currentIssue.body,
      "Blocked by",
      `- Blocked by #${createdIssue.number}`,
    );

    if (nextCurrentBody !== currentIssue.body.trim()) {
      await this.editIssueBody(currentIssue.number, nextCurrentBody);
    }

    return mapGitHubIssueToTask(createdIssue);
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
    await this.ensureNeedsAttentionLabel();
    await this.editIssueLabels(issueNumber, {
      add: [NEEDS_ATTENTION_LABEL],
      remove: [READY_FOR_AGENT_LABEL],
    });
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

  private async createIssue(options: {
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<GitHubIssue> {
    const args = [
      "issue",
      "create",
      "--title",
      options.title,
      "--body",
      options.body,
    ];

    for (const label of options.labels ?? []) {
      args.push("--label", label);
    }

    const output = await this.#gh(args);
    return this.getIssue(parseCreatedIssueNumber(output));
  }

  private async ensureNeedsAttentionLabel(): Promise<void> {
    await this.#gh([
      "label",
      "create",
      NEEDS_ATTENTION_LABEL,
      "--color",
      NEEDS_ATTENTION_LABEL_COLOR,
      "--description",
      NEEDS_ATTENTION_LABEL_DESCRIPTION,
      "--force",
    ]);
  }

  private async editIssueBody(
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.#gh(["issue", "edit", String(issueNumber), "--body", body]);
  }

  private async editIssueLabels(
    issueNumber: number,
    options: {
      readonly add?: readonly string[];
      readonly remove?: readonly string[];
    },
  ): Promise<void> {
    const args = ["issue", "edit", String(issueNumber)];

    for (const label of options.add ?? []) {
      args.push("--add-label", label);
    }

    for (const label of options.remove ?? []) {
      args.push("--remove-label", label);
    }

    await this.#gh(args);
  }

  private async commentOnIssue(
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.#gh(["issue", "comment", String(issueNumber), "--body", body]);
  }
}

const parseScopedTaskIssueNumber = (task: Pick<ScopedTask, "id">): number => {
  const match =
    task.id.match(/^#?(\d+)$/) ?? task.id.match(/github-issue:(\d+)$/);
  const issueNumber = match?.[1] ? Number(match[1]) : Number.NaN;

  if (!Number.isInteger(issueNumber)) {
    throw new Error(
      `Scoped task id must reference a GitHub issue number: ${task.id}`,
    );
  }

  return issueNumber;
};

const toScopedTask = (
  task: GitHubIssueTask,
  unresolvedDependencies: readonly GitHubIssueTaskDependency[],
): ScopedTask => ({
  id: `#${task.issue.number}`,
  title: task.issue.title,
  blockers: unresolvedDependencies.map(
    (dependency) => `#${dependency.issueNumber}`,
  ),
});

export class GitHubImplementationBacklogAdapter implements ImplementationCoordinationBacklogPort {
  readonly #backlog: GitHubIssueBacklog;
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #executionMode: TaskCoordinationComment["executionMode"];
  readonly #claimLeaseMs: number;

  constructor(options: GitHubImplementationBacklogAdapterOptions = {}) {
    this.#backlog = new GitHubIssueBacklog(options);
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? randomUUID;
    this.#executionMode = options.executionMode ?? "host";
    this.#claimLeaseMs = options.claimLeaseMs ?? DEFAULT_TASK_CLAIM_LEASE_MS;
  }

  async loadParent(parent: ParentRef): Promise<ParentEffort> {
    if (parent.issueNumber === undefined) {
      throw new Error(
        "GitHub implementation backlog parent.issueNumber is required.",
      );
    }

    const issue = await this.#backlog.getIssue(parent.issueNumber);
    return {
      id: `#${issue.number}`,
      title: issue.title,
    };
  }

  async listScopedTasks(parent: ParentEffort): Promise<readonly ScopedTask[]> {
    const parentIssueNumber = parseScopedTaskIssueNumber({ id: parent.id });
    const readyIssues = await this.#backlog.listReadyIssues();
    const scopedTasks: ScopedTask[] = [];

    for (const readyIssue of readyIssues.sort(
      (left, right) => left.number - right.number,
    )) {
      const issue = await this.#backlog.getIssue(readyIssue.number);
      if (issue.state !== "OPEN" || isPrdIssue(issue)) {
        continue;
      }

      const task = mapGitHubIssueToTask(issue);
      if (task.parentIssueNumber !== parentIssueNumber) {
        continue;
      }

      if (
        hasRecordedTaskCoordinationDone(issue.comments) ||
        hasIssueLabel(issue, NEEDS_ATTENTION_LABEL)
      ) {
        continue;
      }

      const claimState = getTaskCoordinationClaimState(issue.comments, {
        now: this.#now(),
        defaultLeaseMs: this.#claimLeaseMs,
      });
      if (claimState.status === "claimed") {
        continue;
      }

      const dependencyStates = new Map<number, GitHubIssue["state"]>(
        await Promise.all(
          task.dependencies.map(
            async (dependency) =>
              [
                dependency.issueNumber,
                (await this.#backlog.getIssue(dependency.issueNumber)).state,
              ] as const,
          ),
        ),
      );
      const readiness = getGitHubIssueTaskReadiness(task, dependencyStates);
      scopedTasks.push(toScopedTask(task, readiness.unresolvedDependencies));
    }

    return scopedTasks;
  }

  async claimTask(task: ScopedTask): Promise<void> {
    const issueNumber = parseScopedTaskIssueNumber(task);
    const issue = await this.#backlog.getIssue(issueNumber);
    const claimState = getTaskCoordinationClaimState(issue.comments, {
      now: this.#now(),
      defaultLeaseMs: this.#claimLeaseMs,
    });
    const runId = this.#runId();

    if (claimState.status === "stale") {
      await this.#backlog.reclaimTask(
        issueNumber,
        this.#createComment("reclaim", {
          runId,
          reason: "The prior claim lease expired before selection.",
          reclaimedClaimRunId: claimState.claim?.runId,
          reclaimedLeaseExpiresAt: claimState.leaseExpiresAt,
        }),
      );
    }

    await this.#backlog.claimTask(
      issueNumber,
      this.#createComment("claim", { runId }),
    );
  }

  async reclaimTask(task: ScopedTask): Promise<void> {
    const issue = await this.#backlog.getIssue(
      parseScopedTaskIssueNumber(task),
    );
    const claimState = getTaskCoordinationClaimState(issue.comments, {
      now: this.#now(),
      defaultLeaseMs: this.#claimLeaseMs,
    });

    await this.#backlog.reclaimTask(
      issue.number,
      this.#createComment("reclaim", {
        reason: "The prior claim lease expired before selection.",
        reclaimedClaimRunId: claimState.claim?.runId,
        reclaimedLeaseExpiresAt: claimState.leaseExpiresAt,
      }),
    );
  }

  async releaseTask(task: ScopedTask, reason: string): Promise<void> {
    await this.#backlog.releaseTask(
      parseScopedTaskIssueNumber(task),
      this.#createComment("release", { reason }),
    );
  }

  async markTaskBlocked(
    _task: ScopedTask,
    _outcome: BlockedOutcome,
  ): Promise<void> {
    // Explicit `Blocked by` issue body sections are the durable GitHub-backed
    // dependency state. The implementation coordination core calls this hook to
    // record blocked tasks, but the GitHub adapter must not duplicate that state
    // with a separate needs-attention or claim-lifecycle event.
  }

  async markTaskDone(task: ScopedTask, outcome: DoneOutcome): Promise<void> {
    await this.#backlog.markTaskDone(
      parseScopedTaskIssueNumber(task),
      this.#createComment("done", {
        branch: outcome.branch,
        reason: outcome.verification.summary,
      }),
    );
  }

  async markTaskNeedsAttention(
    task: ScopedTask,
    outcome: NeedsAttentionOutcome,
  ): Promise<void> {
    await this.#backlog.markTaskNeedsAttention(
      parseScopedTaskIssueNumber(task),
      this.#createComment("needs-attention", {
        branch: outcome.branch,
        reason: outcome.summary ?? outcome.reason,
      }),
    );
  }

  #createComment(
    event: TaskCoordinationCommentEvent,
    overrides: Partial<TaskCoordinationComment> = {},
  ): TaskCoordinationComment {
    const now = this.#now();
    return {
      kind: "sandcastle-task-coordination",
      version: 1,
      event,
      runId: this.#runId(),
      executionMode: this.#executionMode,
      recordedAt: now.toISOString(),
      leaseExpiresAt:
        event === "claim"
          ? new Date(now.getTime() + this.#claimLeaseMs).toISOString()
          : undefined,
      ...overrides,
    };
  }
}
