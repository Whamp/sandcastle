---
"@ai-hero/sandcastle": patch
---

Keep build and typecheck working when the optional `@daytona/sdk` peer dependency is not installed by removing the hard type dependency from the Daytona provider, loading the SDK only at runtime, and surfacing a clearer error message when `daytona()` is used without the package present.
