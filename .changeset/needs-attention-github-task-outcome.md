---
"@ai-hero/sandcastle": patch
---

Add a distinct GitHub-backed `needs-attention` Task Coordination outcome that records intervention-worthy execution failures, moves the GitHub Issue from `ready-for-agent` to a visible `needs-attention` label, releases the claim lease, and lets a human return the Task to ready selection later by restoring the labels.
