---
"@ai-hero/sandcastle": patch
---

Expose per-iteration token usage on `IterationResult` via a new `usage?: IterationUsage` field. Claude Code sessions are parsed after capture to extract raw token counts (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) from the last assistant message. Non-Claude agent providers return `undefined`.
