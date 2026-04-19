# TASKS

Here are the open backlog tasks in the repo:

<tasks-json>

!`{{LIST_TASKS_COMMAND}}`

</tasks-json>

# TASK

Analyze the open tasks and build a dependency graph. For each task, determine whether it **blocks** or **is blocked by** any other open task.

Task B is **blocked by** task A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

A task is **unblocked** if it has zero blocking dependencies on other open tasks.

For each unblocked task, assign a branch name using the format `sandcastle/task-{id}-{slug}`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"tasks": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/task-42-fix-auth-bug"}]}
</plan>

Include only unblocked tasks. If every task is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
