import { Effect } from "effect";
import { readConfig } from "./Config.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { DockerSandboxFactory } from "./SandboxFactory.js";
import { resolveTokens } from "./TokenResolver.js";

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 5) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxCreate?: ReadonlyArray<{ command: string }>;
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Target branch name for sandbox work */
  readonly branch?: string;
  /** @internal */
  readonly _imageName?: string;
}

export interface RunResult {
  readonly iterationsRun: number;
  readonly complete: boolean;
}

const SANDBOX_REPOS_DIR = "/home/agent/repos";

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = 5,
    hooks,
    branch,
    _imageName = "sandcastle:local",
  } = options;

  const hostRepoDir = process.cwd();
  const repoName = hostRepoDir.split("/").pop()!;
  const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

  // Resolve prompt
  const resolvedPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile, cwd: hostRepoDir }),
  );

  // Read config
  const config = await Effect.runPromise(readConfig(hostRepoDir));

  // Merge hooks: explicit hooks override config hooks
  const resolvedConfig = hooks ? { ...config, hooks } : config;

  // Resolve tokens and build Docker factory layer
  const tokens = await resolveTokens(hostRepoDir);
  const factoryLayer = DockerSandboxFactory.layer(
    _imageName,
    tokens.oauthToken,
    tokens.ghToken,
  );

  const result = await Effect.runPromise(
    orchestrate({
      hostRepoDir,
      sandboxRepoDir,
      iterations: maxIterations,
      config: resolvedConfig,
      prompt: resolvedPrompt,
      branch,
    }).pipe(Effect.provide(factoryLayer)),
  );

  return { iterationsRun: result.iterationsRun, complete: result.complete };
};
