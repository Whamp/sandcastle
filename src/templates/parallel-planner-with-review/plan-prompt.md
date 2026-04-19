# ISSUES

Here are the open backlog tasks in the repo:

<issues-json>

!`{{LIST_TASKS_COMMAND}}`

</issues-json>

# TASK

Analyze the open tasks and build a dependency graph. For each task, determine whether it **blocks** or **is blocked by** any other open task.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

A task is **unblocked** if it has zero blocking dependencies on other open tasks.

For each unblocked issue, assign a branch name using the format `sandcastle/issue-{id}-{slug}`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42-fix-auth-bug"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).
