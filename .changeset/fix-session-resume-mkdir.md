---
"@ai-hero/sandcastle": patch
---

Fix session resume failing with `docker cp (in) failed` / `podman cp (in) failed` when the sandbox's `~/.claude/projects/<encoded>/` directory didn't yet exist. `sandboxSessionStore.writeSession` now creates the project directory inside the sandbox before copying the session JSONL in.
