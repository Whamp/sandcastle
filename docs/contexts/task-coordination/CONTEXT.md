# Task Coordination

Task Coordination is the core domain of this fork. It consumes ready tasks from upstream Backlog Curation, selects one task at a time from a single backlog adapter, coordinates execution on host-first infrastructure, and records the resulting task outcomes.

## Language

### Core coordination

**Task Coordination**:
The core domain that selects ready tasks, claims them, executes them, lands changes, and closes their backlog artifacts.
_Avoid_: Sandbox orchestration, task runner

**Task**:
The canonical backlog unit the system selects, claims, executes, blocks, and completes.
_Avoid_: Work item, job, ticket

**Issue**:
A GitHub-backed representation of a task.
_Avoid_: Using issue as the canonical backlog term

**Backlog adapter**:
The integration that exposes tasks from one backlog system and projects canonical task concepts onto that system.
_Avoid_: Task source when lifecycle semantics are also involved

**Selection policy**:
The canonical policy that decides which ready task should be worked next.
_Avoid_: Prompt policy

**Claim**:
A durable, adapter-visible reservation that marks a task as in progress for one worker.
_Avoid_: Task state

**Claim lease**:
A time-bounded claim that must be renewed or can expire and be reclaimed.
_Avoid_: Permanent claim

**Task priority**:
The canonical priority assigned to a task for selection ordering.
_Avoid_: Numeric score as the canonical idea

**Task dependency**:
A relationship where one task blocks or is blocked by another task.
_Avoid_: Planner-only prompt logic

**Follow-on task**:
A task created during execution because the current task revealed additional concrete work.
_Avoid_: Idea, note, optional thought

### Task outcomes

**Ready task**:
A task that is eligible for selection because it is not blocked and is available to be claimed.
_Avoid_: Open task when blocked tasks are included

**Blocked task**:
A task that cannot yet be worked because one or more task dependencies are unresolved.
_Avoid_: Using blocked for generic execution trouble

**Needs-attention task**:
A task that a worker attempted but could not complete because it requires intervention beyond ordinary retry.
_Avoid_: Using blocked when the problem is not a task dependency

**Done task**:
A task whose change has landed on the target branch and whose backlog artifact has been closed or marked done.
_Avoid_: Equating implemented or committed with done

### Execution and git safety

**Execution mode**:
The environment shape Task Coordination uses to run an agent.
_Avoid_: Using sandbox or runtime as the generic execution term

**Host execution**:
An execution mode where the agent runs directly on the host.
_Avoid_: No-sandbox as the primary prose term

**Sandboxed execution**:
An execution mode where the agent runs inside an isolated environment such as Docker, Podman, or a remote provider like Vercel.
_Avoid_: Container as the generic term

**Agent provider**:
The integration that builds commands and parses output for a specific coding agent.
_Avoid_: Vendor name as the generic term

**Branch strategy**:
The policy that controls how an agent's changes relate to branches.
_Avoid_: Worktree mode

**Merge-to-head**:
A branch strategy where work happens on a temporary branch and is merged back into the target branch.
_Avoid_: Temp-branch mode

**Worktree**:
A git worktree used to isolate the branch where a task is being worked.
_Avoid_: Workspace

## Relationships

- **Task Coordination** consumes **ready tasks** from **Backlog Curation**
- **Task Coordination** operates against exactly one **backlog adapter** at a time
- **Task Coordination** selects a **ready task** using **selection policy** before invoking an **agent provider**
- A **claim** is a **claim lease** attached to a **task**, not a task state
- A **task** may be represented as an **issue** in GitHub
- A **task** may depend on another **task** and may also have one or more **follow-on tasks**
- Discovering a prerequisite task creates a **follow-on task** and makes the current task a **blocked task**
- Discovering non-blocking work creates a proposed **follow-on task** that returns to **Backlog Curation**
- A **needs-attention task** releases its **claim lease** after the outcome is recorded
- A **done task** has landed on the target branch and its **issue** has been closed
- **Host execution** is the default execution mode for non-interactive runs
- **Merge-to-head** uses a **worktree** to keep host-first automation safe

## Example dialogue

> **Dev:** "What happens once a task is ready?"
>
> **Domain expert:** "**Task Coordination** uses **selection policy** to choose a **ready task**, creates a **claim lease**, and runs the agent through the selected **execution mode**. If the worker discovers a prerequisite, it creates a **follow-on task** and marks the current task **blocked**. If the work lands and the issue closes, the task is **done**."

## Flagged ambiguities

- **"Task"** vs **"Issue"** — **Task** is canonical; **Issue** is the GitHub representation
- **"Blocked"** vs **"Needs-attention"** — **blocked** is for unresolved **task dependencies**; **needs-attention** is for execution problems that need intervention
- **"Claim"** vs **"Task state"** — a **claim** is coordination metadata, not lifecycle state
- **"Implemented"** vs **"Done"** — a task can be implemented without being **done**; **done** requires land plus issue closure
- **"Sandbox"** vs **"Execution mode"** — **execution mode** is the generic term; **sandboxed execution** is only one variant
- **"Runtime"** vs **"Execution mode"** — **runtime** is too overloaded for top-level product language and should stay provider-specific (for example Vercel runtime)
- **"GitHub Issues coordinator"** vs **"GitHub-hosted worker"** — avoid **GitHub Issues coordinator** as public prose. Use **Task Coordination worker backed by the GitHub Issues backlog adapter**. The scaffold template name is `github-issues-coordinator`; it does not mean execution happens on GitHub
