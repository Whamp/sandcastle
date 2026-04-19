/**
 * Daytona isolated sandbox provider.
 *
 * Creates ephemeral Daytona sandboxes via `@daytona/sdk`.
 * Requires `@daytona/sdk` as a peer dependency at runtime.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

/**
 * Typed loosely on purpose so `@daytona/sdk` can remain an optional peer
 * dependency during build and typecheck.
 */
export type DaytonaCreateOptions = Readonly<Record<string, unknown>>;

interface DaytonaExecuteCommandResult {
  result: string;
  exitCode: number;
}

interface DaytonaExecuteSessionCommandResult {
  cmdId?: string;
}

interface DaytonaSessionCommandInfo {
  exitCode?: number;
}

interface DaytonaProcessApi {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    options: { command: string; async: true },
  ): Promise<DaytonaExecuteSessionCommandResult>;
  getSessionCommandLogs(
    sessionId: string,
    cmdId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;
  getSessionCommand(
    sessionId: string,
    cmdId: string,
  ): Promise<DaytonaSessionCommandInfo>;
  deleteSession(sessionId: string): Promise<void>;
  executeCommand(
    command: string,
    cwd: string,
  ): Promise<DaytonaExecuteCommandResult>;
}

interface DaytonaFsApi {
  uploadFile(hostPath: string, sandboxPath: string): Promise<void>;
  downloadFile(sandboxPath: string, hostPath: string): Promise<void>;
}

interface DaytonaSandbox {
  getWorkDir(): Promise<string | undefined>;
  getUserHomeDir(): Promise<string | undefined>;
  process: DaytonaProcessApi;
  fs: DaytonaFsApi;
}

interface DaytonaClient {
  create(options?: DaytonaCreateOptions): Promise<DaytonaSandbox>;
  delete(sandbox: DaytonaSandbox): Promise<void>;
}

interface DaytonaSdkModule {
  Daytona: new (config: DaytonaConfig) => DaytonaClient;
}

const DAYTONA_SDK_MODULE = "@daytona/sdk";

const loadDaytonaSdk = async (): Promise<DaytonaSdkModule> => {
  try {
    return (await import(DAYTONA_SDK_MODULE)) as unknown as DaytonaSdkModule;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown import failure.";
    throw new Error(
      "The Daytona sandbox provider requires the optional peer dependency `@daytona/sdk`. " +
        `Install it to use daytona(). Import failed with: ${message}`,
    );
  }
};

/** Options for the Daytona sandbox provider. */
export interface DaytonaOptions {
  /**
   * Daytona API key for authentication.
   * Falls back to the `DAYTONA_API_KEY` environment variable if not provided.
   */
  readonly apiKey?: string;

  /**
   * Daytona API URL.
   * Falls back to the `DAYTONA_API_URL` environment variable if not provided.
   */
  readonly apiUrl?: string;

  /**
   * Target environment for sandboxes.
   * Falls back to the `DAYTONA_TARGET` environment variable if not provided.
   */
  readonly target?: string;

  /**
   * Options passed through to the Daytona SDK when creating a sandbox.
   * Typed loosely so `@daytona/sdk` stays optional until runtime.
   */
  readonly create?: DaytonaCreateOptions;

  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
}

/**
 * Create a Daytona isolated sandbox provider.
 *
 * Sandboxes are ephemeral — each `create()` call spins up a new Daytona
 * sandbox and `close()` destroys it.
 *
 * @example
 * ```ts
 * import { daytona } from "@ai-hero/sandcastle/sandboxes/daytona";
 *
 * const provider = daytona({ apiKey: "dyt_my_key" });
 * ```
 */
export const daytona = (options?: DaytonaOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "daytona",
    env: options?.env,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const { Daytona } = await loadDaytonaSdk();

      const config: DaytonaConfig = {};
      if (options?.apiKey) config.apiKey = options.apiKey;
      if (options?.apiUrl) config.apiUrl = options.apiUrl;
      if (options?.target) config.target = options.target;

      const client: DaytonaClient = new Daytona(config);
      const sandbox = await client.create(options?.create);

      const worktreePath =
        (await sandbox.getWorkDir()) ??
        (await sandbox.getUserHomeDir()) ??
        "/home/daytona";

      return {
        worktreePath,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          if (opts?.onLine) {
            const onLine = opts.onLine;
            const sessionId = `sandcastle-${crypto.randomUUID()}`;
            await sandbox.process.createSession(sessionId);

            try {
              const execResponse = await sandbox.process.executeSessionCommand(
                sessionId,
                {
                  command: `cd ${opts?.cwd ?? worktreePath} && ${effectiveCommand}`,
                  async: true,
                },
              );

              const cmdId = execResponse.cmdId;
              if (!cmdId) {
                throw new Error("Daytona session command did not return a cmdId");
              }

              const stdoutLines: string[] = [];
              const stderrChunks: string[] = [];
              let partial = "";

              await sandbox.process.getSessionCommandLogs(
                sessionId,
                cmdId,
                (chunk: string) => {
                  const text = partial + chunk;
                  const lines = text.split("\n");
                  partial = lines.pop() ?? "";
                  for (const line of lines) {
                    stdoutLines.push(line);
                    onLine(line);
                  }
                },
                (chunk: string) => {
                  stderrChunks.push(chunk);
                },
              );

              if (partial) {
                stdoutLines.push(partial);
                onLine(partial);
              }

              const cmdInfo = await sandbox.process.getSessionCommand(
                sessionId,
                cmdId,
              );

              return {
                stdout: stdoutLines.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: cmdInfo.exitCode ?? 0,
              };
            } finally {
              await sandbox.process.deleteSession(sessionId).catch(() => {});
            }
          }

          const response = await sandbox.process.executeCommand(
            effectiveCommand,
            opts?.cwd ?? worktreePath,
          );
          return {
            stdout: response.result,
            stderr: "",
            exitCode: response.exitCode,
          };
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            const walk = async (dir: string): Promise<string[]> => {
              const entries = await readdir(dir, { withFileTypes: true });
              const files: string[] = [];
              for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                  files.push(...(await walk(full)));
                } else {
                  files.push(full);
                }
              }
              return files;
            };
            const files = await walk(hostPath);
            for (const file of files) {
              const rel = relative(hostPath, file);
              await sandbox.fs.uploadFile(file, join(sandboxPath, rel));
            }
          } else {
            await sandbox.fs.uploadFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await sandbox.fs.downloadFile(sandboxPath, hostPath);
        },

        close: async (): Promise<void> => {
          await client.delete(sandbox);
        },
      };
    },
  });
