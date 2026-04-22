---
"@ai-hero/sandcastle": patch
---

Add `signal?: AbortSignal` to `RunOptions` for cancelling a run. Aborting mid-iteration kills the in-flight agent subprocess; the worktree is preserved on disk. The rejected promise surfaces `signal.reason` verbatim.
