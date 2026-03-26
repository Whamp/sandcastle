import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import { ExecError, SyncError, type SandboxError } from "./errors.js";
import {
  Sandbox,
  type ExecResult,
  type SandboxService,
} from "./SandboxFactory.js";

const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, ExecError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new ExecError({
            command,
            message: `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          }),
        )
      : Effect.succeed(result),
  );

const execAsync = promisify(exec);

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandcastleConfig["hooks"];
  readonly branch?: string;
  /** Host-side path to the worktree directory. Required when sandboxRepoDir
   *  is a container path that doesn't exist on the host (e.g. /home/agent/workspace). */
  readonly hostWorktreePath?: string;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch, hostWorktreePath } =
      options;

    // Without an explicit branch, record host's current branch for cherry-pick
    const hostCurrentBranch: string | null = !branch
      ? yield* Effect.promise(async () => {
          const { stdout } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: hostRepoDir },
          );
          return stdout.trim();
        })
      : null;

    // Read host git identity before entering the sandbox
    const [hostGitName, hostGitEmail] = yield* Effect.promise(async () => {
      const [nameResult, emailResult] = await Promise.all([
        execAsync("git config user.name", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
        execAsync("git config user.email", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
      ]);
      return [nameResult, emailResult] as const;
    });

    // Setup: onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        // The bind-mounted worktree may be owned by a different UID (host user
        // vs container user). Mark it safe so git doesn't reject it with
        // "dubious ownership".
        yield* execOk(
          sandbox,
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );

        // Propagate host git identity into the sandbox so commits are attributed
        // to the actual developer without requiring manual setup.
        if (hostGitName) {
          yield* execOk(
            sandbox,
            `git config --global user.name "${hostGitName.replace(/"/g, '\\"')}"`,
          );
        }
        if (hostGitEmail) {
          yield* execOk(
            sandbox,
            `git config --global user.email "${hostGitEmail.replace(/"/g, '\\"')}"`,
          );
        }

        // Repo is bind-mounted — discover branch directly
        resolvedBranch = (yield* execOk(
          sandbox,
          "git rev-parse --abbrev-ref HEAD",
          { cwd: sandboxRepoDir },
        )).stdout.trim();

        if (hooks?.onSandboxReady?.length) {
          for (const hook of hooks.onSandboxReady) {
            message(hook.command);
            yield* execOk(sandbox, hook.command, { cwd: sandboxRepoDir });
          }
        }
      }),
    );

    const targetBranch = branch ?? resolvedBranch;

    // Record base HEAD
    const baseHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Collect commits and handle cherry-pick for temp branches
    let commits: { sha: string }[];
    let finalBranch: string;

    // For host-side git operations in worktree mode, use hostWorktreePath
    // (the real path on the host) instead of sandboxRepoDir (which may be a container path
    // like /home/agent/workspace that doesn't exist on the host).
    const hostSideWorktreePath = hostWorktreePath ?? sandboxRepoDir;

    if (hostCurrentBranch !== null) {
      // Temp branch mode: fast-forward host branch to temp branch, then delete temp branch.
      // We use fast-forward instead of cherry-pick because cherry-pick breaks when the
      // temp branch contains merge commits (e.g. a merge agent merging multiple parallel
      // branches). The temp branch is always a direct descendant of hostCurrentBranch,
      // so fast-forward is always valid.

      // Check if there are any new commits on the temp branch
      const hasNewCommits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --count`,
            { cwd: hostSideWorktreePath },
          );
          return parseInt(stdout.trim(), 10) > 0;
        } catch {
          return false;
        }
      });

      // Detach the worktree from the temp branch so the branch can be deleted
      yield* execOk(sandbox, "git checkout --detach", { cwd: sandboxRepoDir });

      if (hasNewCommits) {
        // Fast-forward host's current branch to the temp branch
        yield* Effect.tryPromise({
          try: async () => {
            try {
              await execAsync(`git merge --ff-only "${resolvedBranch}"`, {
                cwd: hostRepoDir,
              });
            } catch {
              throw new Error(
                `Fast-forward merge of '${resolvedBranch}' onto '${hostCurrentBranch}' failed. ` +
                  `The temporary branch '${resolvedBranch}' has been preserved. ` +
                  `To retry: git merge --ff-only ${resolvedBranch}, ` +
                  `then clean up: git branch -D ${resolvedBranch}`,
              );
            }
          },
          catch: (e) =>
            new SyncError({
              message: String(e instanceof Error ? e.message : e),
            }),
        });
      }

      // Delete the temp branch (now merged into host branch)
      yield* Effect.promise(() =>
        execAsync(`git branch -D "${resolvedBranch}"`, {
          cwd: hostRepoDir,
        }).catch(() => {}),
      );

      // Collect the commits now on the host branch
      commits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --reverse`,
            { cwd: hostRepoDir },
          );
          const lines = stdout.trim();
          if (!lines) return [];
          return lines.split("\n").map((sha) => ({ sha }));
        } catch {
          return [];
        }
      });

      finalBranch = hostCurrentBranch;
    } else {
      // Explicit branch: commits stay on that branch
      commits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..refs/heads/${targetBranch}" --reverse`,
            { cwd: hostRepoDir },
          );
          const lines = stdout.trim();
          if (!lines) return [];
          return lines.split("\n").map((sha) => ({ sha }));
        } catch {
          // Branch doesn't exist on host (no commits were produced)
          return [];
        }
      });

      finalBranch = targetBranch;
    }

    return { result, branch: finalBranch, commits };
  });
