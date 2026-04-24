import { exec, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { claudeCode, type AgentProvider } from "./AgentProvider.js";
import {
  LocalImplementationAgentRunnerAdapter,
  LocalImplementationVerifierAdapter,
  LocalImplementationWorkspaceAdapter,
} from "./ImplementationCoordinationLocalAdapters.js";
import type { ScopedTask } from "./ImplementationCoordination.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const execAsync = promisify(exec);

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const streamJson = (text: string) =>
  [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
    JSON.stringify({ type: "result", result: text }),
  ].join("\n");

const fakeAgent = (run: (prompt: string) => string): AgentProvider => {
  const base = claudeCode("test-model");
  return {
    name: "fake-agent",
    env: {},
    captureSessions: false,
    buildPrintCommand: ({ prompt }) => ({ command: run(prompt) }),
    parseStreamLine: base.parseStreamLine,
  };
};

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
  await execAsync(`git add ${shellEscape(name)}`, { cwd: dir });
  await execAsync(`git commit -m ${shellEscape(message)}`, { cwd: dir });
};

const setupRepo = async () => {
  const repo = await mkdtemp(join(tmpdir(), "sandcastle-local-adapters-"));
  await initRepo(repo);
  await commitFile(repo, "README.md", "base\n", "initial");
  return repo;
};

const parent = { id: "16", title: "Local adapters" };
const task: ScopedTask = { id: "task-1", title: "First task" };

const localRunnerRequiresWorkspace = () => {
  // @ts-expect-error Local runner requires the workspace adapter that created the task worktree.
  new LocalImplementationAgentRunnerAdapter({
    workerAgent: {} as AgentProvider,
    sandbox: noSandbox(),
  });
};
void localRunnerRequiresWorkspace;

describe("LocalImplementationWorkspaceAdapter", () => {
  it("creates coordinator and task worktrees from the configured base and current coordinator branch", async () => {
    const repo = await setupRepo();
    try {
      const baseSha = execSync("git rev-parse HEAD", {
        cwd: repo,
        encoding: "utf-8",
      }).trim();
      await commitFile(repo, "after-base.txt", "after\n", "after base");

      const workspace = new LocalImplementationWorkspaceAdapter({
        cwd: repo,
        targetBranch: baseSha,
        coordinatorBranch: "sandcastle/coordinator-16",
        taskBranchPrefix: "sandcastle/task",
      });

      const coordinator = await workspace.createCoordinatorWorkspace({
        parent,
      });
      expect(coordinator.branch).toBe("sandcastle/coordinator-16");
      expect(
        execSync("git rev-parse HEAD", {
          cwd: coordinator.path,
          encoding: "utf-8",
        }).trim(),
      ).toBe(baseSha);

      await commitFile(
        coordinator.path,
        "coordinator.txt",
        "coordinator\n",
        "coordinator change",
      );
      const coordinatorSha = execSync("git rev-parse HEAD", {
        cwd: coordinator.path,
        encoding: "utf-8",
      }).trim();

      const taskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace: coordinator,
      });

      expect(taskWorkspace.branch).toMatch(/^sandcastle\/task\/task-1-/);
      expect(
        execSync("git rev-parse HEAD", {
          cwd: taskWorkspace.path,
          encoding: "utf-8",
        }).trim(),
      ).toBe(coordinatorSha);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("creates a fresh task branch from the latest coordinator state on repeated task workspace creation", async () => {
    const repo = await setupRepo();
    try {
      const workspace = new LocalImplementationWorkspaceAdapter({
        cwd: repo,
        coordinatorBranch: "sandcastle/coordinator-16",
        taskBranchPrefix: "sandcastle/task",
      });
      const coordinator = await workspace.createCoordinatorWorkspace({
        parent,
      });

      await commitFile(
        coordinator.path,
        "first.txt",
        "first\n",
        "first coordinator change",
      );
      const firstTaskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace: coordinator,
      });
      const firstTaskSha = execSync("git rev-parse HEAD", {
        cwd: firstTaskWorkspace.path,
        encoding: "utf-8",
      }).trim();

      await commitFile(
        coordinator.path,
        "second.txt",
        "second\n",
        "second coordinator change",
      );
      const latestCoordinatorSha = execSync("git rev-parse HEAD", {
        cwd: coordinator.path,
        encoding: "utf-8",
      }).trim();
      const secondTaskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace: coordinator,
      });

      expect(secondTaskWorkspace.branch).not.toBe(firstTaskWorkspace.branch);
      expect(secondTaskWorkspace.path).not.toBe(firstTaskWorkspace.path);
      expect(
        execSync("git rev-parse HEAD", {
          cwd: secondTaskWorkspace.path,
          encoding: "utf-8",
        }).trim(),
      ).toBe(latestCoordinatorSha);
      expect(latestCoordinatorSha).not.toBe(firstTaskSha);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("merges accepted task branches, detects integrated changes, reports conflicts with preserved evidence, and pushes only the coordinator branch", async () => {
    const repo = await setupRepo();
    const remote = await mkdtemp(join(tmpdir(), "sandcastle-local-remote-"));
    try {
      await execAsync("git init --bare", { cwd: remote });
      await execAsync(`git remote add origin ${shellEscape(remote)}`, {
        cwd: repo,
      });
      await execAsync("git push -u origin main", { cwd: repo });

      const workspace = new LocalImplementationWorkspaceAdapter({
        cwd: repo,
        targetBranch: "main",
        coordinatorBranch: "sandcastle/coordinator-16",
        remote: "origin",
      });
      const coordinator = await workspace.createCoordinatorWorkspace({
        parent,
      });
      const taskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace: coordinator,
      });
      await commitFile(taskWorkspace.path, "task.txt", "task\n", "task change");

      const merge = await workspace.mergeTaskIntoCoordinator({
        task,
        taskWorkspace,
        coordinatorWorkspace: coordinator,
      });
      expect(merge.merged).toBe(true);
      expect(
        await workspace.hasIntegratedChanges({
          coordinatorWorkspace: coordinator,
          completedTasks: [],
        }),
      ).toBe(true);

      await expect(
        new LocalImplementationWorkspaceAdapter({
          cwd: repo,
          targetBranch: "missing-target-ref",
        }).hasIntegratedChanges({
          coordinatorWorkspace: coordinator,
          completedTasks: [],
        }),
      ).rejects.toThrow(/git diff --quiet failed/);

      await workspace.pushCoordinatorBranch({
        coordinatorWorkspace: coordinator,
      });
      expect(
        execSync("git for-each-ref --format='%(refname:short)' refs/heads", {
          cwd: remote,
          encoding: "utf-8",
        }),
      ).toContain("sandcastle/coordinator-16");

      const conflictTask = await workspace.createTaskWorkspace({
        parent,
        task: { id: "conflict" },
        coordinatorWorkspace: coordinator,
      });
      await writeFile(join(coordinator.path, "conflict.txt"), "coordinator\n");
      await execAsync(
        "git add conflict.txt && git commit -m 'coordinator conflict'",
        {
          cwd: coordinator.path,
        },
      );
      await writeFile(join(conflictTask.path, "conflict.txt"), "task\n");
      await execAsync("git add conflict.txt && git commit -m 'task conflict'", {
        cwd: conflictTask.path,
      });

      const conflict = await workspace.mergeTaskIntoCoordinator({
        task: { id: "conflict" },
        taskWorkspace: conflictTask,
        coordinatorWorkspace: coordinator,
      });
      expect(conflict.merged).toBe(false);
      expect(conflict.summary).toContain("git merge failed");
      expect(conflict.conflictFiles).toContain("conflict.txt");
      expect(conflict.taskBranch).toBe(conflictTask.branch);
      expect(conflict.taskWorkspace).toBe(conflictTask.path);
      expect(conflict.coordinatorBranch).toBe(coordinator.branch);
      expect(conflict.coordinatorWorkspace).toBe(coordinator.path);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });
});

describe("LocalImplementationAgentRunnerAdapter", () => {
  it("runs worker and reviewer profiles through Worktree.run with fake agents", async () => {
    const repo = await setupRepo();
    try {
      const workspace = new LocalImplementationWorkspaceAdapter({ cwd: repo });
      const coordinator = await workspace.createCoordinatorWorkspace({
        parent,
      });
      const taskWorkspace = await workspace.createTaskWorkspace({
        parent,
        task,
        coordinatorWorkspace: coordinator,
      });
      const workerAgent = fakeAgent(
        () =>
          `echo worker > worker.txt && git add worker.txt && git commit -m worker && printf '%s\\n' ${shellEscape(streamJson("worker complete"))}`,
      );
      const reviewerAgent = fakeAgent(
        () =>
          `printf '%s\\n' ${shellEscape(
            streamJson(
              JSON.stringify({ findings: [{ severity: "P2", title: "note" }] }),
            ),
          )}`,
      );
      const runner = new LocalImplementationAgentRunnerAdapter({
        workerAgent,
        reviewerAgent,
        sandbox: noSandbox(),
        workspace,
        workerPrompt: "worker {{TASK_ID}}",
        reviewerPrompt: "review {{TASK_ID}}",
        logging: { type: "stdout" },
      });

      const worker = await runner.runWorker({ parent, task, taskWorkspace });
      expect(worker.summary).toContain("worker complete");
      const review = await runner.runReviewer({
        parent,
        task,
        taskWorkspace,
        workerResult: worker,
      });
      expect(review.findings).toEqual([{ severity: "P2", title: "note" }]);
      expect(
        execSync("git log --oneline -1", {
          cwd: taskWorkspace.path,
          encoding: "utf-8",
        }),
      ).toContain("worker");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("LocalImplementationVerifierAdapter", () => {
  it("runs configured commands and returns structured command results without throwing on non-zero exits", async () => {
    const repo = await setupRepo();
    try {
      const workspace = new LocalImplementationWorkspaceAdapter({ cwd: repo });
      const coordinator = await workspace.createCoordinatorWorkspace({
        parent,
      });
      const verifier = new LocalImplementationVerifierAdapter({
        commands: ["printf ok", "printf err >&2; exit 7"],
      });

      const result = await verifier.verify({
        target: "coordinator",
        parent,
        coordinatorWorkspace: coordinator,
      });

      expect(result.passed).toBe(false);
      expect(result.commands).toHaveLength(2);
      expect(result.commands![0]).toMatchObject({
        command: "printf ok",
        exitCode: 0,
        stdout: "ok",
      });
      expect(result.commands![1]).toMatchObject({
        command: "printf err >&2; exit 7",
        exitCode: 7,
        stderr: "err",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
