---
"@ai-hero/sandcastle": patch
---

Add host-first GitHub Issue Task Coordination support for a structured `blockedByPrerequisite` result hook so workers can surface one concrete blocking prerequisite Task during execution. Task Coordination now creates the prerequisite as a ready GitHub Issue, preserves `Parent` and `Follow-on from` lineage, records explicit `Blocked by` dependency metadata on the current Task, releases the current claim, and only honors the blocking marker when no landed commits were returned so done semantics still win after land.
