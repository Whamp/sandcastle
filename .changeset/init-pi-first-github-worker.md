---
"@ai-hero/sandcastle": patch
---

Make `sandcastle init` default to a Pi-first, host-first GitHub Issues coordinator template, add a dedicated `github-issues-coordinator` scaffold that uses `GitHubIssueBacklog`, `executeNextGitHubIssueTask`, and `noSandbox()`, keep that template pinned to the `github-issues` backlog adapter so invalid single-adapter combinations are rejected, export the GitHub coordination primitives from the public package entrypoint, and skip containerfile/image scaffolding on the default host execution path while keeping Docker and Podman sandboxed-execution templates available.
