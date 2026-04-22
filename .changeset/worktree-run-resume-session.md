---
"@ai-hero/sandcastle": patch
---

`Worktree.run()` (returned from `createWorktree()`) now accepts `resumeSession` to resume a prior Claude Code session by ID. Mirrors the validation on top-level `run()`: the session file must exist on the host, and `resumeSession` cannot be combined with `maxIterations > 1`.
