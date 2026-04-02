---
"@ai-hero/sandcastle": patch
---

Decouple init scaffolding from runtime providers. `envManifest` and `dockerfileTemplate` removed from `AgentProvider` interface. `sandcastle init` now has `--agent` and `--model` flags with interactive agent selection. Dockerfile templates owned by init's internal registry. Each template carries a static `.env.example` file copied as-is during scaffold. Scaffolded `main.ts` is rewritten with the selected agent factory and model.
