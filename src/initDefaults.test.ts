import { describe, expect, it } from "vitest";
import {
  DEFAULT_INIT_AGENT_NAME,
  DEFAULT_INIT_BACKLOG_MANAGER_NAME,
  DEFAULT_INIT_EXECUTION_MODE,
  DEFAULT_INIT_TEMPLATE_NAME,
  getInitExecutionMode,
  initExecutionModeRequiresImageBuild,
  templateSupportsInitBacklogManager,
  templateSupportsInitExecutionMode,
} from "./initDefaults.js";

describe("init defaults", () => {
  it("defaults init to the Pi-first host-first GitHub worker path", () => {
    expect(DEFAULT_INIT_AGENT_NAME).toBe("pi");
    expect(DEFAULT_INIT_TEMPLATE_NAME).toBe("github-worker");
    expect(DEFAULT_INIT_BACKLOG_MANAGER_NAME).toBe("github-issues");
    expect(DEFAULT_INIT_EXECUTION_MODE).toBe("host");
  });

  it("treats host execution as the only no-image-build path", () => {
    expect(initExecutionModeRequiresImageBuild("host")).toBe(false);
    expect(initExecutionModeRequiresImageBuild("docker")).toBe(true);
    expect(initExecutionModeRequiresImageBuild("podman")).toBe(true);
  });

  it("keeps the host-first GitHub worker on host execution and sandbox-oriented templates on sandboxed execution", () => {
    expect(templateSupportsInitExecutionMode("github-worker", "host")).toBe(
      true,
    );
    expect(templateSupportsInitExecutionMode("github-worker", "docker")).toBe(
      false,
    );
    expect(templateSupportsInitExecutionMode("blank", "host")).toBe(false);
    expect(templateSupportsInitExecutionMode("blank", "docker")).toBe(true);
    expect(templateSupportsInitExecutionMode("blank", "podman")).toBe(true);
  });

  it("keeps the github-worker template pinned to GitHub Issues while sandbox-oriented templates stay backlog-manager agnostic", () => {
    expect(
      templateSupportsInitBacklogManager("github-worker", "github-issues"),
    ).toBe(true);
    expect(templateSupportsInitBacklogManager("github-worker", "beads")).toBe(
      false,
    );
    expect(templateSupportsInitBacklogManager("blank", "github-issues")).toBe(
      true,
    );
    expect(templateSupportsInitBacklogManager("blank", "beads")).toBe(true);
  });

  it("lists host execution as the default init execution mode option", () => {
    expect(getInitExecutionMode("host")).toMatchObject({
      name: "host",
      label: "Host execution",
      hint: "Recommended default for the host-first GitHub Issue Task Coordination worker",
    });
  });
});
