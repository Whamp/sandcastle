import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCKERFILE, PROMPT } from "./templates.js";

const ENV_EXAMPLE = `CLAUDE_CODE_OAUTH_TOKEN=
GH_TOKEN=
`;

const GITIGNORE = `.env
patches/
`;

export async function scaffold(repoDir: string): Promise<void> {
  const configDir = join(repoDir, ".sandcastle");

  try {
    await mkdir(configDir, { recursive: false });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
      );
    }
    throw err;
  }

  await Promise.all([
    writeFile(join(configDir, "Dockerfile"), DOCKERFILE),
    writeFile(join(configDir, "prompt.md"), PROMPT),
    writeFile(join(configDir, ".env.example"), ENV_EXAMPLE),
    writeFile(join(configDir, ".gitignore"), GITIGNORE),
  ]);
}
