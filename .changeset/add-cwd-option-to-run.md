---
"@ai-hero/sandcastle": patch
---

Add `cwd` option to `run()`. When provided, it replaces `process.cwd()` as the host repo directory anchor for `.sandcastle/logs/`, `.sandcastle/.env`, worktrees, patches, and git operations. The `tail -f` log-file hint prints a relative path when `cwd` equals `process.cwd()` and an absolute path otherwise. `promptFile` continues to resolve against `process.cwd()`, not `cwd` (per ADR 0002).
