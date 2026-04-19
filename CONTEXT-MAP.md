# Context Map

This repo now spans two strategic contexts: upstream **Backlog Curation** and downstream **Task Coordination**.

## Contexts

- [Backlog Curation](./docs/contexts/backlog-curation/CONTEXT.md) — turns discovery into PRDs and promotable tasks
- [Task Coordination](./docs/contexts/task-coordination/CONTEXT.md) — selects ready tasks, claims them, executes them, lands changes, and closes issue-backed tasks

## Relationships

- **Backlog Curation → Task Coordination**: Backlog Curation promotes **proposed tasks** to **ready tasks**; Task Coordination consumes **ready tasks**
- **Task Coordination → Backlog Curation**: Task Coordination may create **proposed follow-on tasks**, which return to Backlog Curation for promotion
- **Backlog Curation ↔ Task Coordination**: Every **task** traces to one primary **PRD** shaped in Backlog Curation; Task Coordination updates the task artifact as work progresses

## Notes

- **Backlog Curation** is upstream/external to this fork's product boundary, but it is included here because its outputs and language shape Task Coordination
- The typical upstream curation flow is: discovery conversation → PRD synthesis → task or issue breakdown
- The typical downstream coordination flow is: ready task selection → claim lease → execution → land → close or record outcome
