# TASK COORDINATION

Task Coordination already selected the GitHub Issue-backed Task.

- Selected Issue: #{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}
- Parent PRD: {{PARENT_ISSUE_NUMBER}} — {{PARENT_ISSUE_TITLE}}
- Execution mode: host execution
- Source branch for this run: {{SOURCE_BRANCH}}
- Target branch for land: {{TARGET_BRANCH}}

Pull in the selected issue using `gh issue view`, with comments. If `{{PARENT_ISSUE_NUMBER}}` is not `none`, pull in that parent PRD too.

Only work on the selected GitHub Issue Task. Do not choose from the backlog.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# TASK COORDINATION RESULT HOOK

If execution discovers one concrete, repo-relevant Task outcome that Task Coordination should record, emit exactly one structured result payload in your final output before `<promise>COMPLETE</promise>`:

<sandcastle-task-coordination-result>
{"blockedByPrerequisite":{"title":"Concrete blocking prerequisite Task title","body":"## What to build\n\nDescribe the prerequisite Task that must land before the current Task can continue.\n"}}
</sandcastle-task-coordination-result>

Or:

<sandcastle-task-coordination-result>
{"proposedFollowOn":{"title":"Concrete follow-on Task title","body":"## What to build\n\nDescribe the concrete follow-on Task.\n"}}
</sandcastle-task-coordination-result>

Rules:

- Use `"blockedByPrerequisite"` for one concrete blocking prerequisite Task.
- Use `"proposedFollowOn"` for one concrete non-blocking follow-on Task that should return to Backlog Curation.
- Emit at most one structured payload and at most one of those keys. If no Task outcome is needed, omit the tag entirely.
- Keep the JSON valid. Do not wrap the tagged payload in a markdown code fence.
- Do not create, close, or relabel the GitHub Issue yourself. Task Coordination will translate `"blockedByPrerequisite"` into a ready GitHub Issue, preserve follow-on lineage, record explicit `Blocked by` dependency metadata on the current Task, and release the claim. Task Coordination will translate `"proposedFollowOn"` into a proposed follow-on GitHub Issue and keep it outside normal ready selection until Backlog Curation promotes it.

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the GitHub issue with what was done.

Do not close the issue. Task Coordination will only close the GitHub Issue after the landed change is on the target branch.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
