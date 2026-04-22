---
"@ai-hero/sandcastle": patch
---

Show commit-aware sync logs only for isolated sandboxes. Displays "Syncing N commit(s) to host" when commits exist or "No commits to sync out" when there are none, instead of the generic "Syncing changes to host" message. Bind-mount providers no longer show sync logs since sync-out only applies to isolated sandboxes.
