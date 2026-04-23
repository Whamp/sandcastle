import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  create,
  generateTempBranchName,
  hasUncommittedChanges,
  pruneStale,
  remove,
  sanitizeName,
} from "./WorktreeManager.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getBranch = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
  });
  return stdout.trim();
};

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  return repoDir;
};

/** Run an Effect and return its success value, throwing on failure. */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
      A,
      never
    >,
  );

/** Run an Effect and return the error, throwing if it succeeds. */
const runFail = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.flip(effect).pipe(
      Effect.provide(NodeFileSystem.layer),
    ) as Effect.Effect<E, never>,
  );

describe("sanitizeName", () => {
  it("lowercases the name", () => {
    expect(sanitizeName("Claude-Code")).toBe("claude-code");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(sanitizeName("my agent!")).toBe("my-agent-");
  });

  it("passes through a typical name unchanged", () => {
    expect(sanitizeName("claude-code")).toBe("claude-code");
  });

  it("handles names with dots and slashes", () => {
    expect(sanitizeName("my/agent.v2")).toBe("my-agent-v2");
  });
});

describe("generateTempBranchName", () => {
  it("returns a string in sandcastle/<YYYYMMDD-HHMMSS> format", () => {
    const name = generateTempBranchName();
    expect(name).toMatch(/^sandcastle\/\d{8}-\d{6}$/);
  });

  it("returns different names when called at different times", async () => {
    const a = generateTempBranchName();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const b = generateTempBranchName();
    expect(a).not.toBe(b);
  });

  it("includes sanitized name when provided", () => {
    const name = generateTempBranchName("my-run");
    expect(name).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}$/);
  });

  it("sanitizes the name in the branch", () => {
    const name = generateTempBranchName("My Run!");
    expect(name).toMatch(/^sandcastle\/my-run-\/\d{8}-\d{6}$/);
  });
});

describe("WorktreeManager.create", () => {
  it("creates a worktree at .sandcastle/worktrees/<name>/", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    expect(path).toContain(join(repoDir, ".sandcastle", "worktrees"));
    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
  });

  it("returns the branch name", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir));
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });

  it("creates a sandcastle/<timestamp> branch when no branch is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir));
    expect(branch).toMatch(/^sandcastle\/\d{8}-\d{6}$/);
  });

  it("includes name in branch when name is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await run(create(repoDir, { name: "my-run" }));
    expect(branch).toMatch(/^sandcastle\/my-run\/\d{8}-\d{6}$/);
  });

  it("includes name in worktree directory when name is specified", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir, { name: "my-run" }));
    expect(path).toMatch(/sandcastle-my-run-\d{8}-\d{6}$/);
  });

  it("checks out the specified branch when branch is given", async () => {
    const repoDir = await setupRepo();
    // Create a branch first
    await execAsync("git checkout -b feature/my-feature", { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "x", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const { path, branch } = await run(
      create(repoDir, { branch: "feature/my-feature" }),
    );
    expect(branch).toBe("feature/my-feature");
    expect(await getBranch(path)).toBe("feature/my-feature");
  });

  it("the worktree directory is on the correct branch", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    // The worktree should have a valid git repo
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: path,
    });
    expect(stdout.trim()).toMatch(/^sandcastle\//);
  });

  it("reuses existing clean worktree for the same branch", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));
    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
  });

  it("reuses dirty worktree with a warning", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Make the worktree dirty
    await writeFile(join(first.path, "dirty.txt"), "uncommitted");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
  });

  it("parallel runs on different branches work without interference", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b branch-a", { cwd: repoDir });
    await commitFile(repoDir, "a.txt", "a", "branch-a commit");
    await execAsync("git checkout main", { cwd: repoDir });
    await execAsync("git checkout -b branch-b", { cwd: repoDir });
    await commitFile(repoDir, "b.txt", "b", "branch-b commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const [wtA, wtB] = await Promise.all([
      run(create(repoDir, { branch: "branch-a" })),
      run(create(repoDir, { branch: "branch-b" })),
    ]);

    expect(wtA.branch).toBe("branch-a");
    expect(wtB.branch).toBe("branch-b");
    expect(wtA.path).not.toBe(wtB.path);

    await run(remove(wtA.path));
    await run(remove(wtB.path));
  });

  it("creates a new branch from HEAD when specified branch does not exist", async () => {
    const repoDir = await setupRepo();
    const { path, branch } = await run(
      create(repoDir, { branch: "sandcastle/issue-42-new-feature" }),
    );

    expect(branch).toBe("sandcastle/issue-42-new-feature");
    expect(await getBranch(path)).toBe("sandcastle/issue-42-new-feature");

    // The worktree should have the same HEAD as the main repo
    const { stdout: mainHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(mainHead.trim());

    await run(remove(path));
  });

  it("creates a new branch from baseBranch when specified", async () => {
    const repoDir = await setupRepo();

    // Create a second commit on main so HEAD differs from the base
    await commitFile(repoDir, "second.txt", "second", "second commit");

    // Record the first commit's SHA (the one before "second commit")
    const { stdout: baseSha } = await execAsync("git rev-parse HEAD~1", {
      cwd: repoDir,
    });

    const { path, branch } = await run(
      create(repoDir, {
        branch: "feature/from-base",
        baseBranch: baseSha.trim(),
      }),
    );

    expect(branch).toBe("feature/from-base");
    expect(await getBranch(path)).toBe("feature/from-base");

    // The worktree should be at the base commit, not HEAD
    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(baseSha.trim());

    await run(remove(path));
  });

  it("ignores baseBranch when the branch already exists", async () => {
    const repoDir = await setupRepo();

    // Create a branch with a known commit
    await execAsync("git checkout -b existing-branch", { cwd: repoDir });
    await commitFile(repoDir, "on-branch.txt", "x", "branch commit");
    const { stdout: branchHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });
    await execAsync("git checkout main", { cwd: repoDir });

    // Add another commit on main to use as baseBranch
    await commitFile(repoDir, "main2.txt", "y", "main commit 2");
    const { stdout: mainHead } = await execAsync("git rev-parse HEAD", {
      cwd: repoDir,
    });

    // baseBranch should be ignored since existing-branch already exists
    const { path } = await run(
      create(repoDir, {
        branch: "existing-branch",
        baseBranch: mainHead.trim(),
      }),
    );

    const { stdout: worktreeHead } = await execAsync("git rev-parse HEAD", {
      cwd: path,
    });
    expect(worktreeHead.trim()).toBe(branchHead.trim());

    await run(remove(path));
  });

  it("reuses worktree with unpushed commits (not considered dirty)", async () => {
    const repoDir = await setupRepo();
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const first = await run(create(repoDir, { branch: "my-branch" }));

    // Add a committed (but unpushed) change — should NOT count as dirty
    await commitFile(first.path, "extra.txt", "extra", "extra commit");

    const second = await run(create(repoDir, { branch: "my-branch" }));

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("my-branch");

    await run(remove(first.path));
  });

  it("detects collision when branch is checked out in the main working tree", async () => {
    const repoDir = await setupRepo();
    // "main" is the currently checked-out branch in the main working tree
    const err = await runFail(create(repoDir, { branch: "main" }));
    expect(err.message).toMatch(/already checked out/i);
  });
});

describe("WorktreeManager.remove", () => {
  it("removes the worktree directory", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    await run(remove(path));

    await expect(stat(path)).rejects.toThrow();
  });

  it("removes git worktree metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    await run(remove(path));

    // After removal, the worktree should not appear in git worktree list
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });
});

describe("WorktreeManager.pruneStale", () => {
  it("runs git worktree prune to clean up stale metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Manually delete the worktree directory (simulating a crash)
    const { execSync } = await import("node:child_process");
    execSync(`rm -rf "${path}"`);

    // pruneStale should not throw
    await run(pruneStale(repoDir));

    // Git metadata should be cleaned up
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });

  it("removes orphaned directories under .sandcastle/worktrees/", async () => {
    const repoDir = await setupRepo();
    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });

    // Create an orphaned directory (not backed by a git worktree)
    const orphanDir = join(worktreesDir, "orphan-dir");
    await mkdir(orphanDir);

    await run(pruneStale(repoDir));

    const entries = await readdir(worktreesDir).catch(() => []);
    expect(entries).not.toContain("orphan-dir");
  });

  it("does not remove active worktrees", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));
    const name = path.split("/").pop()!;

    await run(pruneStale(repoDir));

    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
    // cleanup
    await run(remove(path));
    // suppress unused var warning
    void name;
  });
});

describe("WorktreeManager.hasUncommittedChanges", () => {
  it("returns false for a clean worktree", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(false);

    await run(remove(path));
  });

  it("returns true when there are unstaged modifications", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Modify a tracked file without staging
    await writeFile(join(path, "hello.txt"), "modified content");

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });

  it("returns true when there are staged changes", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Stage a new file
    await writeFile(join(path, "new-file.txt"), "new content");
    await execAsync("git add new-file.txt", { cwd: path });

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });

  it("returns true when there are untracked files", async () => {
    const repoDir = await setupRepo();
    const { path } = await run(create(repoDir));

    // Add an untracked file
    await writeFile(join(path, "untracked.txt"), "untracked");

    const result = await run(hasUncommittedChanges(path));
    expect(result).toBe(true);

    await run(remove(path));
  });
});
