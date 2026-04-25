import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const earlyReadme = readme.slice(0, readme.indexOf("## Execution Providers"));

describe("README first-run onboarding", () => {
  it("guides a brand-new user through the default GitHub Issues host-execution run", () => {
    expect(earlyReadme).toContain(
      "Sandcastle helps you point an AI coding agent at a ready GitHub issue, run that agent against your repo, and record what happened.",
    );

    expect(earlyReadme).toContain("Node.js and npm");
    expect(earlyReadme).toContain(
      "GitHub CLI authenticated with `gh auth login` (recommended)",
    );
    expect(earlyReadme).toContain(
      "If you use token auth instead, export `GH_TOKEN` in your shell before running `gh issue` commands or the generated worker:",
    );
    expect(earlyReadme).toContain(
      "`.sandcastle/.env` is for the selected agent credential",
    );
    expect(earlyReadme).toContain(
      "selected agent credential such as `ANTHROPIC_API_KEY`",
    );
    expect(earlyReadme).toContain("GitHub repository with Issues enabled");

    expect(earlyReadme).toContain("npx sandcastle init");
    expect(earlyReadme).toContain(
      "cp .sandcastle/.env.example .sandcastle/.env",
    );
    expect(earlyReadme).toContain(
      'gh label create ready-for-agent --description "Ready for Sandcastle agent work" --color 0E8A16 --force',
    );
    expect(earlyReadme).toContain("gh issue create");
    expect(earlyReadme).toContain("ready-for-agent");
    expect(earlyReadme).toContain(
      "`.sandcastle/main.mts` unless your package.json has `type: module`, in which case it creates `.sandcastle/main.ts`.",
    );
    expect(earlyReadme).toContain("npx tsx .sandcastle/main.mts");

    expect(earlyReadme).toContain("No ready GitHub Issue Task found.");
    expect(earlyReadme).toContain("adds a claim note to that issue");
    expect(earlyReadme).toContain("runs the selected agent on your host machine");
    expect(earlyReadme).toContain(
      "closes the issue or records the task outcome",
    );
  });
});
