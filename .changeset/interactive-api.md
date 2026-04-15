---
"@ai-hero/sandcastle": patch
---

Add `interactive()` API for launching interactive agent sessions inside sandboxes, replacing the old `interactive` CLI command. Includes the `sandbox.interactive()` method on `createSandbox()`, full prompt preprocessing (promptFile, shell expressions, argument substitution), all three branch strategies, `onSandboxReady` hooks, `copyToWorkspace` for worktree providers, env resolution, and `interactiveExec` on Docker and Podman providers. ClackDisplay now shows intro/summary and progress (creating worktree, copying files, starting sandbox, syncing, merging, commit collection) for interactive sessions.
