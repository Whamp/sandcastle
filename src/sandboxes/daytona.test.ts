import { describe, expect, it } from "vitest";
import { daytona } from "./daytona.js";

describe("daytona()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'daytona'", () => {
    const provider = daytona();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("daytona");
  });

  it("accepts config and env options without loading the SDK at import time", () => {
    const provider = daytona({
      apiKey: "test-key",
      apiUrl: "https://daytona.example.com",
      target: "test-target",
      create: { image: "node:22" },
      env: { DAYTONA_VAR: "value" },
    });

    expect(provider.tag).toBe("isolated");
    expect(provider.env).toEqual({ DAYTONA_VAR: "value" });
    expect(typeof provider.create).toBe("function");
  });
});
