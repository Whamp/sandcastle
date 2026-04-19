// Parallel Planner — three-phase task-coordination loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open backlog tasks, builds a
//                      dependency graph, and outputs a <plan> JSON listing
//                      unblocked tasks with their target branch names.
//   Phase 2 (Execute): N sonnet agents run in parallel via Promise.allSettled,
//                      each working a single task on its own branch.
//   Phase 3 (Merge):   A sonnet agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// tasks are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandboxed execution environment before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open task list,
  // builds a dependency graph, and selects the tasks that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open tasks).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code.
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-6"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  // The plan JSON contains an array of tasks, each with id, title, and branch.
  const { tasks } = JSON.parse(planMatch[1]!) as {
    tasks: { id: string; title: string; branch: string }[];
  };

  if (tasks.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked tasks to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${tasks.length} task(s) to work in parallel:`,
  );
  for (const task of tasks) {
    console.log(`  ${task.id}: ${task.title} → ${task.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute
  //
  // Spawn one sonnet agent per task, all running concurrently.
  // Each agent works on its own branch so there are no conflicts during
  // execution — merging happens in Phase 3.
  //
  // Promise.allSettled means one failing agent doesn't cancel the others.
  // -------------------------------------------------------------------------
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      sandcastle.run({
        hooks,
        copyToWorktree,
        // Each agent starts on its own branch via branchStrategy on run().
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: task.branch },
        name: "implementer",
        // Give each agent plenty of room to implement and iterate on tests.
        maxIterations: 100,
        // Sonnet for execution: fast and capable enough for typical task work.
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile: "./.sandcastle/implement-prompt.md",
        // Prompt arguments substitute {{TASK_ID}}, {{TASK_TITLE}},
        // and {{BRANCH}} placeholders in implement-prompt.md before the
        // agent sees the prompt.
        promptArgs: {
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          BRANCH: task.branch,
        },
      }),
    ),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${tasks[i]!.id} (${tasks[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedTasks = settled
    .map((outcome, i) => ({ outcome, task: tasks[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<
          Awaited<ReturnType<typeof sandcastle.run>>
        >;
        task: (typeof tasks)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.task);

  const completedBranches = completedTasks.map((task) => task.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One sonnet agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still works.
  //
  // The {{BRANCHES}} and {{TASKS}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which tasks to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    // Sonnet is sufficient for merge conflict resolution.
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((branch) => `- ${branch}`).join("\n"),
      // A markdown list of task IDs and titles, one per line.
      TASKS: completedTasks
        .map((task) => `- ${task.id}: ${task.title}`)
        .join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
