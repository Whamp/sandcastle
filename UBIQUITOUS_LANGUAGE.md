# Ubiquitous Language

## Core concepts

| Term           | Definition                                                                                            | Aliases to avoid                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Sandcastle** | The TypeScript CLI tool that orchestrates AI coding agents inside isolated environments               | "the tool", "the CLI", "RALPH"                                                          |
| **Sandbox**    | An isolated environment where an agent executes code — either a Docker container or a local directory | "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature) |
| **Host**       | The developer's machine where Sandcastle runs and the real git repo lives                             | "local" (ambiguous — the sandbox also has a local filesystem)                           |
| **Agent**      | The AI coding tool invoked inside the sandbox (e.g. Claude Code, Codex)                               | "RALPH", "the bot", "Claude" (too specific — agent is swappable)                        |

## Sync operations

| Term         | Definition                                                                                               | Aliases to avoid              |
| ------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Sync-in**  | Transferring the host repo state into the sandbox via git bundle                                         | "push", "upload", "deploy"    |
| **Sync-out** | Extracting commits and uncommitted changes from the sandbox back to the host via format-patch and git am | "pull", "download", "extract" |
| **Bundle**   | A git bundle file used to transfer repository state from host to sandbox without a network round-trip    | "archive", "snapshot"         |
| **Patch**    | A `git format-patch` output file representing a commit made inside the sandbox                           | "diff", "changeset"           |

## Execution

| Term                  | Definition                                                                                                                     | Aliases to avoid                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Iteration**         | A single invocation of the agent inside the sandbox, producing at most one commit against one task                             | "run" (ambiguous with the CLI command), "cycle", "loop" |
| **Task**              | A GitHub issue that the agent selects and works on during an iteration                                                         | "job", "work item", "ticket"                            |
| **Completion signal** | The `<promise>COMPLETE</promise>` marker in the agent's output indicating all actionable tasks are finished                    | "done flag", "exit signal"                              |
| **Orchestrator**      | The module that drives the iteration loop: sync-in, invoke agent, check for commits, sync-out, check completion signal, repeat | "runner", "loop", "wrapper script"                      |

## Architecture

| Term                 | Definition                                                                                                          | Aliases to avoid                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Sandbox service**  | The Effect service interface exposing `exec`, `copyIn`, and `copyOut` operations against a sandbox                  | "adapter", "transport"               |
| **Docker layer**     | The `Sandbox` service implementation that uses `docker exec` and `docker cp`                                        | "Docker adapter", "Docker transport" |
| **Filesystem layer** | The `Sandbox` service implementation that uses local shell and `cp` against a separate directory — used for testing | "local adapter", "test adapter"      |
| **Sync service**     | The module built on top of `Sandbox` that implements sync-in and sync-out using git bundles and format-patch        | "sync layer", "git sync"             |

## Relationships

- **Sandcastle** orchestrates an **agent** inside a **sandbox**
- A **sandbox** is provided by either the **Docker layer** or the **filesystem layer**, both implementing the **Sandbox service** interface
- The **sync service** depends on the **Sandbox service** to transfer files and execute git commands
- **Sync-in** creates a **bundle** on the **host** and unpacks it in the **sandbox**
- **Sync-out** generates **patches** in the **sandbox** and applies them on the **host**
- Each **iteration** may produce one **patch**; iterations repeat until the **completion signal** fires or the max count is reached

## Example dialogue

> **Dev:** "How do I test the **sync service** without Docker?"
> **Domain expert:** "Provide the **filesystem layer** instead of the **Docker layer**. It implements the same **Sandbox service** interface but uses a local directory as the **sandbox**."
> **Dev:** "So **sync-in** still creates a **bundle** and unpacks it?"
> **Domain expert:** "Exactly. The **sync service** doesn't know which layer it's talking to. It calls `exec` and `copyIn` — the **filesystem layer** just runs those as local shell commands."
> **Dev:** "And when the **agent** makes a commit in the **sandbox**, **sync-out** extracts the **patch** the same way regardless?"
> **Domain expert:** "Right. The **sync service** calls `exec` to run `git format-patch` and `copyOut` to get the **patch** file back to the **host**."

## Flagged ambiguities

- **"Docker sandbox"** — In this project, **sandbox** refers to our isolated environment concept. It is NOT Claude Code's built-in `docker sandbox` CLI feature. Use **sandbox** for ours; spell out "Claude's Docker sandbox CLI" for the built-in feature.
- **"Container"** vs **"Sandbox"** — "Container" is the Docker primitive; **sandbox** is our abstraction over it. Use **sandbox** when talking about the concept, "container" only when discussing Docker implementation details.
- **"Local"** vs **"Host"** — Both could mean the developer's machine, but "local" is ambiguous (the filesystem layer's sandbox is also local). Use **host** to mean the developer's machine. Reserve "local" for generic contexts.
- **"Run"** — Ambiguous between the CLI command (`sandcastle run`) and a single **iteration**. Use **iteration** for one agent invocation; use "run command" or "run session" for the CLI command that drives multiple iterations.
- **"Adapter"** vs **"Layer"** — We use **layer** (Effect terminology) for implementations of the **Sandbox service**. Avoid "adapter" and "transport" as they suggest different patterns.
