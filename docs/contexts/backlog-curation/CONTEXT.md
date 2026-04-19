# Backlog Curation

Backlog Curation is the upstream process that turns discovery into executable backlog. It establishes shared understanding, creates PRDs, decomposes them into tasks, and promotes the tasks that are ready for automated coordination.

## Language

**Backlog Curation**:
The upstream process that shapes discovery into PRDs and promotable tasks.
_Avoid_: Implementation, coordination

**Shared understanding**:
Alignment on the problem, outcomes, and scope before tasks are made executable.
_Avoid_: Spec when the work is still exploratory

**PRD**:
The canonical curation artifact that captures a shaped concept and justifies one or more tasks.
_Avoid_: Issue, note, task

**Task breakdown**:
The decomposition of a PRD into one or more tasks.
_Avoid_: Implementation plan when referring to backlog shaping

**Proposed task**:
A task visible to curation but not yet eligible for normal coordination.
_Avoid_: Ready task

**Ready task**:
A task that curation has promoted as implementable and eligible for Task Coordination.
_Avoid_: Draft task

**Promotion**:
The curation decision that moves a proposed task to ready.
_Avoid_: Claim, selection

**Primary PRD**:
The single PRD a task traces to.
_Avoid_: Project, parent issue

## Relationships

- **Backlog Curation** turns **shared understanding** into a **PRD**
- A **PRD** decomposes through **task breakdown** into one or more **proposed tasks**
- **Promotion** moves a **proposed task** to **ready task**
- Every **task** has exactly one **primary PRD**
- **Task Coordination** consumes **ready tasks** but does not own **promotion**
- **Task Coordination** may create **proposed tasks** that return to **Backlog Curation**

## Example dialogue

> **Dev:** "We just finished a discovery session with an AI assistant. What happens before the worker starts coding?"
>
> **Domain expert:** "That is **Backlog Curation**. First we establish **shared understanding**, then we write a **PRD**, then we do **task breakdown**. The resulting tasks start as **proposed tasks**, and only the ones we explicitly **promote** become **ready tasks** for Task Coordination."

## Flagged ambiguities

- **"Concept"** vs **"PRD"** — a concept is raw input to curation; the canonical artifact is the **PRD**
- **"Proposed"** vs **"Ready"** — **proposed tasks** are visible to curation; **ready tasks** are eligible for Task Coordination
- **"Curation"** vs **"Coordination"** — **Backlog Curation** shapes backlog; **Task Coordination** executes ready work
