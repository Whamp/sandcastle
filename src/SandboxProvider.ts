/**
 * Sandbox provider types — the pluggable interface for sandbox runtimes.
 *
 * Provider authors implement a small Promise-based interface. Sandcastle
 * handles worktree creation, git mount resolution, and commit extraction.
 */

/** Result of executing a command inside a sandbox. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Handle to a running bind-mount sandbox. */
export interface BindMountSandboxHandle {
  /** Absolute path to the workspace inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a command inside the sandbox. */
  exec(command: string, options?: { cwd?: string }): Promise<ExecResult>;
  /** Execute a command, streaming stdout line-by-line. */
  execStreaming(
    command: string,
    onLine: (line: string) => void,
    options?: { cwd?: string },
  ): Promise<ExecResult>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to a bind-mount provider's `create` function. */
export interface BindMountCreateOptions {
  /** Host-side path to the worktree directory. */
  readonly worktreePath: string;
  /** Host-side path to the original repo root. */
  readonly hostRepoPath: string;
  /** Volume mounts to apply (host:sandbox pairs). */
  readonly mounts: Array<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }>;
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createBindMountSandboxProvider. */
export interface BindMountSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "docker", "podman"). */
  readonly name: string;
  /** Create a sandbox handle from the given options. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** Handle to a running isolated sandbox (extends bind-mount with file transfer). */
export interface IsolatedSandboxHandle {
  /** Absolute path to the workspace inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a command inside the sandbox. */
  exec(command: string, options?: { cwd?: string }): Promise<ExecResult>;
  /** Execute a command, streaming stdout line-by-line. */
  execStreaming(
    command: string,
    onLine: (line: string) => void,
    options?: { cwd?: string },
  ): Promise<ExecResult>;
  /** Copy a file from the host into the sandbox. */
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a file from the sandbox to the host. */
  copyOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to an isolated provider's `create` function. */
export interface IsolatedCreateOptions {
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createIsolatedSandboxProvider. */
export interface IsolatedSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "daytona", "e2b"). */
  readonly name: string;
  /** Create an isolated sandbox handle from the given options. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** A bind-mount sandbox provider. */
export interface BindMountSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "bind-mount";
  /** Human-readable provider name. */
  readonly name: string;
  /** @internal Create a sandbox handle. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** An isolated sandbox provider. */
export interface IsolatedSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "isolated";
  /** Human-readable provider name. */
  readonly name: string;
  /** @internal Create an isolated sandbox handle. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/**
 * A sandbox provider — the pluggable unit that `run()` and `createSandbox()` accept.
 * Tagged for internal dispatch: "bind-mount" or "isolated".
 */
export type SandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider;

/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createBindMountSandboxProvider = (
  config: BindMountSandboxProviderConfig,
): BindMountSandboxProvider => ({
  tag: "bind-mount",
  name: config.name,
  create: config.create,
});

/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  create: config.create,
});
