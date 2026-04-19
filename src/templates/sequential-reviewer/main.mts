// Sequential Reviewer — implement-then-review loop
//
// This template drives a two-phase workflow per task:
//   Phase 1 (Implement): A sonnet agent picks the next open task, works on it
//                        on a temporary branch, and merge-to-head lands the
//                        resulting commits back onto the target branch.
//   Phase 2 (Review):    A second sonnet agent reviews that landed change set
//                        and either approves it or makes corrections directly
//                        on the landed branch.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one task per
// iteration. This is a middle-complexity option between the simple-loop (no review
// gate) and the parallel-planner (concurrent execution with a planning phase).
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

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one task. Raise this to process more tasks per run.
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
  // Phase 1: Implement
  //
  // A sonnet agent picks the next open task, creates a branch, writes the
  // implementation (using RGR: Red → Green → Repeat → Refactor), and commits
  // the result.
  //
  // The agent signals completion via <promise>COMPLETE</promise> when done.
  // The result contains the landed target branch plus the landed commits.
  // -------------------------------------------------------------------------
  const implement = await sandcastle.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "merge-to-head" },
    name: "implementer",
    maxIterations: 100,
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/implement-prompt.md",
  });

  // In merge-to-head mode, implement.branch is the landed target branch.
  const branch = implement.branch;

  if (!implement.commits.length) {
    console.log("Implementation agent made no commits. Skipping review.");
    continue;
  }

  const reviewBase = `${implement.commits[0]!.sha}^`;
  const reviewHead = implement.commits[implement.commits.length - 1]!.sha;

  console.log(`\nImplementation complete on branch: ${branch}`);
  console.log(`Commits: ${implement.commits.length}`);

  // -------------------------------------------------------------------------
  // Phase 2: Review
  //
  // A second sonnet agent reviews the landed change set from Phase 1.
  // It uses {{BRANCH}}, {{REVIEW_BASE}}, and {{REVIEW_HEAD}} to inspect the
  // landed branch and the exact commit range from this iteration.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "branch", branch },
    name: "reviewer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/review-prompt.md",
    // Prompt arguments substitute the landed-branch review context in
    // review-prompt.md before the agent sees the prompt.
    promptArgs: {
      BRANCH: branch,
      REVIEW_BASE: reviewBase,
      REVIEW_HEAD: reviewHead,
    },
  });

  console.log("\nReview complete.");
}

console.log("\nAll done.");
