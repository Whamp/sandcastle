# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
4. If tests fail, fix the failures before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE TASKS

For each branch that was merged, close its task using the following command:

`{{CLOSE_TASK_COMMAND}}`

Here are all the tasks:

{{TASKS}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
