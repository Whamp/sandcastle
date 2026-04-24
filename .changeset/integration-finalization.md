---
"@ai-hero/sandcastle": patch
---

Add the public GitHub-first Integration Finalization API and documentation for coordination PRs, including accepted-for-integration versus done lifecycle semantics, pending/no-op and finalization-needs-attention outcomes, idempotent finalized/already-finalized/retry-needed behavior, durable finalization reports, accepted child Task convergence after partial GitHub write failures, and retry-safe behavior that avoids duplicate done events.
