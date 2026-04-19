import type { InitExecutionMode } from "./InitService.js";

export const DEFAULT_INIT_AGENT_NAME = "pi";
export const DEFAULT_INIT_TEMPLATE_NAME = "github-worker";
export const DEFAULT_INIT_BACKLOG_MANAGER_NAME = "github-issues";
export const DEFAULT_INIT_EXECUTION_MODE: InitExecutionMode = "host";

export interface InitExecutionModeOption {
  readonly name: InitExecutionMode;
  readonly label: string;
  readonly hint: string;
}

const INIT_EXECUTION_MODES: readonly InitExecutionModeOption[] = [
  {
    name: "host",
    label: "Host execution (no sandbox)",
    hint: "Recommended for the host-first GitHub worker",
  },
  {
    name: "docker",
    label: "Docker sandboxed execution",
    hint: "Use with sandbox-oriented templates",
  },
  {
    name: "podman",
    label: "Podman sandboxed execution",
    hint: "Use with sandbox-oriented templates",
  },
];

export const listInitExecutionModes = (): readonly InitExecutionModeOption[] =>
  INIT_EXECUTION_MODES;

export const getInitExecutionMode = (
  name: string,
): InitExecutionModeOption | undefined =>
  INIT_EXECUTION_MODES.find((option) => option.name === name);

export const initExecutionModeRequiresImageBuild = (
  executionMode: InitExecutionMode,
): boolean => executionMode !== "host";

export const templateSupportsInitExecutionMode = (
  template: string,
  executionMode: InitExecutionMode,
): boolean =>
  template === DEFAULT_INIT_TEMPLATE_NAME
    ? executionMode === "host"
    : executionMode !== "host";

export const templateSupportsInitBacklogManager = (
  template: string,
  backlogManager: string,
): boolean =>
  template === DEFAULT_INIT_TEMPLATE_NAME
    ? backlogManager === DEFAULT_INIT_BACKLOG_MANAGER_NAME
    : true;

export const templateUsesSandcastleLabelPrompt = (template: string): boolean =>
  template !== DEFAULT_INIT_TEMPLATE_NAME;
