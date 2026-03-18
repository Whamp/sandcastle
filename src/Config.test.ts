import { Effect } from "effect";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "./Config.js";

const setupConfigDir = async (
  repoDir: string,
  config: Record<string, unknown>,
) => {
  const configDir = join(repoDir, ".sandcastle");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify(config));
};

describe("readConfig", () => {
  it("reads defaultIterations from config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { defaultIterations: 10 });

    const config = await Effect.runPromise(readConfig(repoDir));
    expect(config.defaultIterations).toBe(10);
  });

  it("returns undefined for defaultIterations when not set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {});

    const config = await Effect.runPromise(readConfig(repoDir));
    expect(config.defaultIterations).toBeUndefined();
  });

  it("returns empty config when file does not exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const config = await Effect.runPromise(readConfig(repoDir));
    expect(config.defaultIterations).toBeUndefined();
  });
});
