---
"@ai-hero/sandcastle": patch
---

Rename `copyToSandbox` option to `copyToWorkspace` across the public API (`run()`, `interactive()`, `createSandbox()`) and rename internal module `CopyToSandbox.ts` to `CopyToWorkspace.ts`. This aligns with the formalized distinction between "sandbox" (isolation boundary) and "workspace" (directory where the agent runs). No behavior changes.
