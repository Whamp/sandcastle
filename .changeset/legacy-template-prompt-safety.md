---
"@ai-hero/sandcastle": patch
---

Make the legacy `simple-loop` and `sequential-reviewer` init templates truthful about their post-land behavior: stop telling the agent to close tasks from inside merge-to-head implement prompts, describe `simple-loop` as leaving task closure to your workflow, describe `sequential-reviewer` as a post-land review pass on the landed branch, and make the sequential reviewer inspect the landed commit range instead of diffing `main...{{BRANCH}}` after land.
