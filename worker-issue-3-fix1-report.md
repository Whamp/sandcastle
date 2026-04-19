# Issue #3 fix report: prevent reselection after `done`

## What changed

- Updated `src/GitHubIssueBacklog.ts` so Task Coordination treats any recorded `done` comment as terminal for selection.
- `selectNextReadyTask()` now skips open GitHub Issues that already have a structured `done` event, preventing a landed Task from being selected again if `gh issue close` fails or leaves the Issue open.
- Tightened `.changeset/github-issue-success-path.md` so it describes the actual repo-local `.sandcastle` workflow surface.

## Tests added/updated

- `src/GitHubIssueBacklog.test.ts`
  - added a regression test proving an open GitHub Issue with a recorded `done` event is skipped in favor of the next ready Task.
- `src/GitHubIssueSuccessPath.test.ts`
  - added a regression test covering the failure path where `markTaskDone()` succeeds, `closeTask()` fails, and the next coordinator pass must select a different ready Task instead of re-running the landed one.

## Verification results

### TDD regression check before the fix

- `npx vitest run src/GitHubIssueBacklog.test.ts src/GitHubIssueSuccessPath.test.ts`
  - Failed as expected before the implementation change:
    - backlog test reselected the open Issue with a recorded `done` event
    - success-path retry hit `close failed for issue #3` because the same landed Issue was selected again

### Focused verification after the fix

- `npx vitest run src/GitHubIssueBacklog.test.ts src/GitHubIssueSuccessPath.test.ts`
  - Passed.
- `npx prettier --check src/GitHubIssueBacklog.ts src/GitHubIssueBacklog.test.ts src/GitHubIssueSuccessPath.test.ts .changeset/github-issue-success-path.md`
  - Passed.

### Type checking

- `npm run typecheck`
  - Pre-existing failure only:
    - `src/sandboxes/daytona.ts` cannot resolve `@daytona/sdk`
  - No new failures surfaced from the GitHub Issue Task Coordination fix.

## Commit SHA

- Recorded in the final handoff response from the current `HEAD` commit.

## Remaining risks / open questions

- This fix makes recorded `done` terminal for reselection, but the broader failure-handling gap remains: execution/close failures still do not record a separate needs-attention outcome or release path beyond the existing narrow behavior.
- A human or future automation policy still has to decide how to reconcile an open GitHub Issue that already has a landed `done` marker after close failure.
