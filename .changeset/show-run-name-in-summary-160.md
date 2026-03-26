---
"@ai-hero/sandcastle": patch
---

Show run name instead of provider name in log-to-file summary (issue #160).

When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.
