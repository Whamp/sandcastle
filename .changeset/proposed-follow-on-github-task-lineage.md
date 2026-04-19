---
"@ai-hero/sandcastle": patch
---

Add host-first GitHub Issue Task Coordination support for creating one proposed follow-on issue during execution without adding `ready-for-agent`, preserve lineage through `Parent` and `Follow-on from` body sections, keep proposed follow-ons out of normal ready-task selection until upstream Backlog Curation promotes them, make follow-on creation best-effort so the current Task still releases or closes cleanly, and teach the bundled host-first `.sandcastle` workflow to emit the structured proposed-follow-on result payload.
