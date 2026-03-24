import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold } from "./InitService.js";
import { DOCKERFILE, PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

describe("InitService scaffold", () => {
  it("creates .sandcastle/ with Dockerfile, prompt.md, .env.example, .gitignore", async () => {
    const dir = await makeDir();
    await scaffold(dir);

    const configDir = join(dir, ".sandcastle");

    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(DOCKERFILE);

    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toBe(PROMPT);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(envExample).toContain("GH_TOKEN=");

    const gitignore = await readFile(join(configDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".env");
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));

    await expect(scaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes patches/ in .gitignore", async () => {
    const dir = await makeDir();
    await scaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("patches/");
  });

  it("does not create config.json", async () => {
    const dir = await makeDir();
    await scaffold(dir);

    await expect(
      readFile(join(dir, ".sandcastle", "config.json"), "utf-8"),
    ).rejects.toThrow();
  });
});
