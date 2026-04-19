---
"@ai-hero/sandcastle": patch
---

Map explicit GitHub-backed Task dependencies from `## Blocked by` into first-class Task metadata, treating only standalone entries like `- #123` or `- Blocked by #123` as blockers, exclude unresolved dependencies from ready-task selection, and keep non-landed execution outcomes on the release path instead of reusing dependency-blocked semantics.
