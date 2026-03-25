import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProvider } from "./AgentProvider.js";

const GITIGNORE = `.env
patches/
logs/
worktrees/
`;

function buildEnvExample(envManifest: Record<string, string>): string {
  return (
    Object.entries(envManifest)
      .map(([key, comment]) => `# ${comment}\n${key}=`)
      .join("\n") + "\n"
  );
}

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

async function getTemplateDir(templateName: string): Promise<string> {
  const templateDir = join(getTemplatesDir(), templateName);
  try {
    await readFile(join(templateDir, "template.json"), "utf-8");
  } catch {
    throw new Error(
      `Unknown template: "${templateName}". Check available templates in src/templates/.`,
    );
  }
  return templateDir;
}

async function copyTemplateFiles(
  templateDir: string,
  destDir: string,
): Promise<void> {
  const files = await readdir(templateDir);
  await Promise.all(
    files
      .filter((f) => f !== "template.json")
      .map((f) => copyFile(join(templateDir, f), join(destDir, f))),
  );
}

export async function scaffold(
  repoDir: string,
  provider: AgentProvider,
  templateName = "blank",
): Promise<void> {
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

  const templateDir = await getTemplateDir(templateName);

  await Promise.all([
    writeFile(join(configDir, "Dockerfile"), provider.dockerfileTemplate),
    writeFile(
      join(configDir, ".env.example"),
      buildEnvExample(provider.envManifest),
    ),
    writeFile(join(configDir, ".gitignore"), GITIGNORE),
    writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ agent: provider.name }, null, 2) + "\n",
    ),
    copyTemplateFiles(templateDir, configDir),
  ]);
}
