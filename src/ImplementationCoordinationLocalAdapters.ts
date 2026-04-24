import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createWorktree, type Worktree } from "./createWorktree.js";
import type { AgentProvider } from "./AgentProvider.js";
import type { LoggingOption } from "./run.js";
import type { SandboxHooks } from "./SandboxLifecycle.js";
import type { SandboxProvider } from "./SandboxProvider.js";
import {
  type CoordinatorWorkspace,
  type CreateCoordinatorWorkspaceOptions,
  type CreateTaskWorkspaceOptions,
  type HasIntegratedChangesOptions,
  type ImplementationCoordinationAgentRunnerPort,
  type ImplementationCoordinationWorkspacePort,
  type MergeResult,
  type MergeTaskOptions,
  type ParentEffort,
  type PushCoordinatorOptions,
  type ReviewFinding,
  type ReviewerResult,
  type RunReviewerOptions,
  type RunWorkerOptions,
  type ScopedTask,
  type TaskWorkspace,
  type VerificationCommandResult,
  type VerificationPort,
  type VerificationResult,
  type VerifyOptions,
  type WorkerResult,
} from "./ImplementationCoordination.js";

const execFileAsync = promisify(execFile);

const sanitizeBranchSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";

const git = async (
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf-8",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
};

const gitOrThrow = async (cwd: string, args: readonly string[]) => {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "git failed",
    );
  }
  return result.stdout;
};

const lastJsonObject = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to scanning individual log lines for the final JSON payload.
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    for (const candidate of [line, extractJsonPayload(line)]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error("Reviewer output did not contain a JSON findings object.");
};

const extractJsonPayload = (line: string): string | undefined => {
  try {
    const parsed = JSON.parse(line) as {
      result?: unknown;
      message?: { content?: unknown };
    };
    if (typeof parsed.result === "string") return parsed.result;
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      const text = content
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? (entry as { text?: unknown }).text
            : undefined,
        )
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      return text || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const isReviewFinding = (value: unknown): value is ReviewFinding => {
  if (typeof value !== "object" || value === null) return false;
  const finding = value as { severity?: unknown; title?: unknown };
  return (
    ["P0", "P1", "P2", "P3"].includes(String(finding.severity)) &&
    typeof finding.title === "string"
  );
};

const parseReviewerResult = (stdout: string): ReviewerResult => {
  const parsed = lastJsonObject(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { findings?: unknown }).findings) ||
    !(parsed as { findings: unknown[] }).findings.every(isReviewFinding)
  ) {
    throw new Error(
      "Reviewer output did not match { findings: ReviewFinding[] }.",
    );
  }
  return { findings: (parsed as { findings: ReviewFinding[] }).findings };
};

const renderPrompt = (
  template: string,
  values: Record<string, string>,
): string =>
  Object.entries(values).reduce(
    (prompt, [key, value]) => prompt.replaceAll(`{{${key}}}`, value),
    template,
  );

const mutableCompletionSignal = (
  completionSignal: string | readonly string[] | undefined,
): string | string[] | undefined => {
  if (completionSignal === undefined || typeof completionSignal === "string") {
    return completionSignal;
  }
  return [...completionSignal];
};

export interface LocalImplementationWorkspaceAdapterOptions {
  readonly cwd?: string;
  readonly targetBranch?: string;
  readonly coordinatorBranch?: string;
  readonly taskBranchPrefix?: string;
  readonly remote?: string;
  readonly copyToWorktree?: readonly string[];
  readonly hooks?: SandboxHooks;
}

export class LocalImplementationWorkspaceAdapter implements ImplementationCoordinationWorkspacePort {
  private readonly worktrees = new Map<string, Worktree>();
  private readonly cwd: string;
  private readonly targetBranch: string;
  private readonly coordinatorBranch?: string;
  private readonly taskBranchPrefix: string;
  private readonly remote: string;

  constructor(
    private readonly options: LocalImplementationWorkspaceAdapterOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.targetBranch = options.targetBranch ?? "main";
    this.coordinatorBranch = options.coordinatorBranch;
    this.taskBranchPrefix = options.taskBranchPrefix ?? "sandcastle/task";
    this.remote = options.remote ?? "origin";
  }

  async createCoordinatorWorkspace(
    options: CreateCoordinatorWorkspaceOptions,
  ): Promise<CoordinatorWorkspace> {
    const branch =
      this.coordinatorBranch ??
      `sandcastle/coordinator/${sanitizeBranchSegment(options.parent.id)}-${randomUUID().slice(0, 8)}`;
    const worktree = await createWorktree({
      cwd: this.cwd,
      branchStrategy: {
        type: "branch",
        branch,
        baseBranch: this.targetBranch,
      },
      copyToWorktree: [...(this.options.copyToWorktree ?? [])],
      hooks: this.options.hooks,
    });
    this.worktrees.set(worktree.worktreePath, worktree);
    return {
      id: worktree.worktreePath,
      path: worktree.worktreePath,
      branch: worktree.branch,
    };
  }

  async createTaskWorkspace(
    options: CreateTaskWorkspaceOptions,
  ): Promise<TaskWorkspace> {
    await gitOrThrow(options.coordinatorWorkspace.path, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const branch = `${this.taskBranchPrefix}/${sanitizeBranchSegment(options.task.id)}-${randomUUID().slice(0, 8)}`;
    const worktree = await createWorktree({
      cwd: this.cwd,
      branchStrategy: {
        type: "branch",
        branch,
        baseBranch: options.coordinatorWorkspace.branch,
      },
      copyToWorktree: [...(this.options.copyToWorktree ?? [])],
      hooks: this.options.hooks,
    });
    this.worktrees.set(worktree.worktreePath, worktree);
    return {
      id: worktree.worktreePath,
      path: worktree.worktreePath,
      branch: worktree.branch,
    };
  }

  async mergeTaskIntoCoordinator(
    options: MergeTaskOptions,
  ): Promise<MergeResult> {
    const result = await git(options.coordinatorWorkspace.path, [
      "merge",
      "--no-ff",
      "--no-edit",
      options.taskWorkspace.branch,
    ]);
    if (result.exitCode === 0) {
      return {
        merged: true,
        summary: `Merged ${options.taskWorkspace.branch} into ${options.coordinatorWorkspace.branch}.`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }

    const conflicts = await git(options.coordinatorWorkspace.path, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    const abort = await git(options.coordinatorWorkspace.path, [
      "merge",
      "--abort",
    ]);
    if (abort.exitCode !== 0) {
      await git(options.coordinatorWorkspace.path, ["reset", "--merge"]);
    }
    return {
      merged: false,
      summary: `git merge failed for ${options.taskWorkspace.branch}: ${
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.exitCode}`
      }`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      conflictFiles: conflicts.stdout.split(/\r?\n/).filter(Boolean),
      taskBranch: options.taskWorkspace.branch,
      taskWorkspace: options.taskWorkspace.path,
      coordinatorBranch: options.coordinatorWorkspace.branch,
      coordinatorWorkspace: options.coordinatorWorkspace.path,
    };
  }

  async hasIntegratedChanges(
    options: HasIntegratedChangesOptions,
  ): Promise<boolean> {
    const result = await git(options.coordinatorWorkspace.path, [
      "diff",
      "--quiet",
      `${this.targetBranch}...HEAD`,
    ]);
    if (result.exitCode === 0) return false;
    if (result.exitCode === 1) return true;
    throw new Error(
      `git diff --quiet failed with exit ${result.exitCode}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }

  async pushCoordinatorBranch(options: PushCoordinatorOptions): Promise<void> {
    await gitOrThrow(options.coordinatorWorkspace.path, [
      "push",
      this.remote,
      `${options.coordinatorWorkspace.branch}:${options.coordinatorWorkspace.branch}`,
    ]);
  }

  getWorktree(
    workspace: CoordinatorWorkspace | TaskWorkspace,
  ): Worktree | undefined {
    return this.worktrees.get(workspace.path);
  }
}

export interface LocalImplementationAgentRunnerAdapterOptions {
  readonly workerAgent: AgentProvider;
  readonly reviewerAgent?: AgentProvider;
  readonly sandbox: SandboxProvider;
  readonly workspace: LocalImplementationWorkspaceAdapter;
  readonly workerPrompt?: string;
  readonly reviewerPrompt?: string;
  readonly workerMaxIterations?: number;
  readonly reviewerMaxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly logging?: LoggingOption;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;
}

export class LocalImplementationAgentRunnerAdapter implements ImplementationCoordinationAgentRunnerPort {
  constructor(
    private readonly options: LocalImplementationAgentRunnerAdapterOptions,
  ) {}

  async runWorker(options: RunWorkerOptions): Promise<WorkerResult> {
    const worktree = await this.resolveWorktree(options.taskWorkspace);
    const result = await worktree.run({
      agent: this.options.workerAgent,
      sandbox: this.options.sandbox,
      prompt: renderPrompt(
        this.options.workerPrompt ??
          "Implement task {{TASK_ID}}: {{TASK_TITLE}}",
        {
          ...promptValues(options.parent, options.task),
          PREVIOUS_REVIEW_FINDINGS: JSON.stringify(
            options.previousReviewFindings ?? [],
          ),
        },
      ),
      maxIterations: this.options.workerMaxIterations ?? 1,
      completionSignal: mutableCompletionSignal(this.options.completionSignal),
      idleTimeoutSeconds: this.options.idleTimeoutSeconds,
      logging: this.options.logging,
      hooks: this.options.hooks,
      env: this.options.env,
      name: "implementation-worker",
    });
    return {
      summary: result.stdout.trim() || `Worker completed on ${result.branch}.`,
    };
  }

  async runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
    const worktree = await this.resolveWorktree(options.taskWorkspace);
    const result = await worktree.run({
      agent: this.options.reviewerAgent ?? this.options.workerAgent,
      sandbox: this.options.sandbox,
      prompt: renderPrompt(
        this.options.reviewerPrompt ??
          "Review task {{TASK_ID}} and return JSON findings.",
        {
          ...promptValues(options.parent, options.task),
          WORKER_SUMMARY: options.workerResult.summary,
        },
      ),
      maxIterations: this.options.reviewerMaxIterations ?? 1,
      completionSignal: mutableCompletionSignal(this.options.completionSignal),
      idleTimeoutSeconds: this.options.idleTimeoutSeconds,
      logging: this.options.logging,
      hooks: this.options.hooks,
      env: this.options.env,
      name: "implementation-reviewer",
    });
    return parseReviewerResult(result.stdout);
  }

  private async resolveWorktree(workspace: TaskWorkspace): Promise<Worktree> {
    const existing = this.options.workspace.getWorktree(workspace);
    if (!existing) {
      throw new Error(
        `Task workspace ${workspace.path} (${workspace.branch}) was not created by the configured LocalImplementationWorkspaceAdapter.`,
      );
    }
    return existing;
  }
}

const promptValues = (
  parent: ParentEffort,
  task: ScopedTask,
): Record<string, string> => ({
  PARENT_ID: parent.id,
  PARENT_TITLE: parent.title ?? parent.id,
  TASK_ID: task.id,
  TASK_TITLE: task.title ?? task.id,
});

export interface LocalImplementationVerifierAdapterOptions {
  readonly commands: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export class LocalImplementationVerifierAdapter implements VerificationPort {
  constructor(
    private readonly options: LocalImplementationVerifierAdapterOptions,
  ) {}

  async verify(options: VerifyOptions): Promise<VerificationResult> {
    const cwd =
      this.options.cwd ??
      (options.target === "task"
        ? (options.taskWorkspace?.path ?? options.coordinatorWorkspace.path)
        : options.coordinatorWorkspace.path);
    const commands: VerificationCommandResult[] = [];
    for (const command of this.options.commands) {
      commands.push(await runCommand(command, cwd, this.options.env));
    }
    const failed = commands.filter((command) => command.exitCode !== 0);
    return {
      target: options.target,
      passed: failed.length === 0,
      summary:
        failed.length === 0
          ? `${commands.length} verification command(s) passed.`
          : `${failed.length} of ${commands.length} verification command(s) failed.`,
      commands,
    };
  }
}

const runCommand = (
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<VerificationCommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        command,
        cwd,
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
