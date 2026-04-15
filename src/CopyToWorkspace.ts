import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

/**
 * Copy files and directories from the host repo root to the worktree root,
 * using `cp -R --reflink=auto` for copy-on-write when the filesystem supports it.
 * Missing paths are silently skipped.
 */
export const copyToWorkspace = (
  paths: string[],
  hostRepoDir: string,
  worktreePath: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    for (const relativePath of paths) {
      const src = join(hostRepoDir, relativePath);
      if (!existsSync(src)) {
        continue;
      }
      const dest = join(worktreePath, relativePath);
      yield* Effect.async<void, never>((resume) => {
        execFile("cp", ["-R", "--reflink=auto", src, dest], (error) => {
          if (error) {
            // Fall back to a regular copy if reflink is not supported
            execFile("cp", ["-R", src, dest], () => {
              resume(Effect.succeed(undefined));
            });
          } else {
            resume(Effect.succeed(undefined));
          }
        });
      });
    }
  });
