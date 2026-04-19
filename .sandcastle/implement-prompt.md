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
