import * as sandcastle from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
import { docker } from "../dist/sandboxes/docker";

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.interactive({
  sandbox: docker(),
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorkspace: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
