import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { claudeCode, type AgentProvider } from "./AgentProvider.js";
import {
  formatTaskCoordinationComment,
  GitHubIssueBacklog,
  parseTaskCoordinationComment,
} from "./GitHubIssueBacklog.js";
import {
  executeNextGitHubIssueTask,
  type ExecuteGitHubIssueTaskOptions,
} from "./GitHubIssueSuccessPath.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const shellEscape = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";

const makeHostFirstIssueAgent = (eventsPath: string): AgentProvider => {
  const baseProvider = claudeCode("test-model");
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "working" }] },
  });
  const resultLine = JSON.stringify({
    type: "result",
    result: "<promise>COMPLETE</promise>",
  });

  return {
    name: "github-issue-success-path-agent",
    env: {},
    buildPrintCommand: () =>
      [
        `printf '%s\\n' ${shellEscape(assistantLine)}`,
        `printf '%s\\n' ${shellEscape("agent-start")} >> ${shellEscape(eventsPath)}`,
        `echo 'implemented from selected issue' > ${shellEscape("issue-task-output.txt")}`,
        `git add ${shellEscape("issue-task-output.txt")}`,
        `git commit -m ${shellEscape("host-first issue task commit")}`,
        `printf '%s\\n' ${shellEscape(resultLine)}`,
      ].join(" && "),
    parseStreamLine: baseProvider.parseStreamLine,
  };
};

interface InMemoryIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: "OPEN" | "CLOSED";
  readonly labels: string[];
  readonly comments: Array<{
    readonly body: string;
    readonly createdAt?: string;
    readonly author?: { readonly login: string };
  }>;
  readonly url?: string;
}

const createInMemoryGh = (options: {
  readonly issues: InMemoryIssue[];
  readonly failCloseIssueNumbers?: ReadonlySet<number>;
}) => {
  const issuesByNumber = new Map(
    options.issues.map((issue) => [issue.number, issue]),
  );

  return async (args: string[]): Promise<string> => {
    if (args[0] !== "issue") {
      throw new Error(`Unsupported gh args: ${args.join(" ")}`);
    }

    if (args[1] === "list") {
      return JSON.stringify(
        options.issues
          .filter((issue) => issue.state === "OPEN")
          .filter((issue) => issue.labels.includes("ready-for-agent"))
          .map((issue) => ({ number: issue.number, title: issue.title })),
      );
    }

    if (args[1] === "view") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) {
        throw new Error(`Unknown issue #${args[2]}`);
      }

      return JSON.stringify(issue);
    }

    if (args[1] === "comment") {
      const issue = issuesByNumber.get(Number(args[2]));
      const bodyIndex = args.indexOf("--body");
      const body = args[bodyIndex + 1];
      if (!issue || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }

      issue.comments.push({
        body,
        createdAt: new Date().toISOString(),
        author: { login: "sandcastle-test" },
      });

      return "";
    }

    if (args[1] === "close") {
      const issueNumber = Number(args[2]);
      const issue = issuesByNumber.get(issueNumber);
      if (!issue) {
        throw new Error(`Unknown issue #${args[2]}`);
      }

      if (options.failCloseIssueNumbers?.has(issueNumber)) {
        throw new Error(`close failed for issue #${issueNumber}`);
      }

      issue.state = "CLOSED";
      return "";
    }

    throw new Error(`Unsupported gh args: ${args.join(" ")}`);
  };
};

const writeFakeGhCli = (options: {
  readonly binDir: string;
  readonly storePath: string;
  readonly eventsPath: string;
}) => {
  const scriptPath = join(options.binDir, "gh");

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");

const storePath = process.env.FAKE_GH_STORE_PATH;
const eventsPath = process.env.FAKE_GH_EVENTS_PATH;

const readStore = () => JSON.parse(readFileSync(storePath, "utf8"));
const writeStore = (store) => writeFileSync(storePath, JSON.stringify(store, null, 2));
const log = (line) => appendFileSync(eventsPath, line + "\\n");
const args = process.argv.slice(2);

if (args[0] !== "issue") {
  throw new Error("Unsupported gh command: " + args.join(" "));
}

const stripRepoArgs = (input) => {
  const output = [];
  for (let index = 0; index < input.length; index++) {
    if (input[index] === "--repo") {
      index++;
      continue;
    }
    output.push(input[index]);
  }
  return output;
};

const normalizedArgs = stripRepoArgs(args);
const store = readStore();

if (normalizedArgs[1] === "list") {
  const issues = store.issues
    .filter((issue) => issue.state === "OPEN")
    .filter((issue) => issue.labels.includes("ready-for-agent"))
    .map((issue) => ({ number: issue.number, title: issue.title }));

  process.stdout.write(JSON.stringify(issues));
  process.exit(0);
}

if (normalizedArgs[1] === "view") {
  const issueNumber = Number(normalizedArgs[2]);
  const issue = store.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new Error("Unknown issue #" + issueNumber);
  }

  process.stdout.write(JSON.stringify(issue));
  process.exit(0);
}

if (normalizedArgs[1] === "comment") {
  const issueNumber = Number(normalizedArgs[2]);
  const bodyIndex = normalizedArgs.indexOf("--body");
  const body = normalizedArgs[bodyIndex + 1];
  const issue = store.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new Error("Unknown issue #" + issueNumber);
  }

  issue.comments.push({
    body,
    createdAt: new Date().toISOString(),
    author: { login: "sandcastle-test" },
  });
  writeStore(store);

  const event = body.includes('"event": "claim"')
    ? "claim"
    : body.includes('"event": "done"')
      ? "done"
      : body.includes('"event": "release"')
        ? "release"
        : "unknown";
  log("comment:" + issueNumber + ":" + event);
  process.exit(0);
}

if (normalizedArgs[1] === "close") {
  const issueNumber = Number(normalizedArgs[2]);
  const issue = store.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new Error("Unknown issue #" + issueNumber);
  }

  issue.state = "CLOSED";
  writeStore(store);

  const landed = execSync(
    "git log --format=%B --grep='host-first issue task commit' -n 1",
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim().length > 0;
  log("close:" + issueNumber + ":landed=" + (landed ? "yes" : "no"));
  process.exit(0);
}

throw new Error("Unsupported gh command: " + normalizedArgs.join(" "));
`,
  );

  chmodSync(scriptPath, 0o755);
};

describe("executeNextGitHubIssueTask", () => {
  it("reclaims a stale GitHub-backed claim lease before making a fresh claim", async () => {
    const staleClaimComment = formatTaskCoordinationComment({
      kind: "sandcastle-task-coordination",
      version: 1,
      event: "claim",
      runId: "run-stale-claim",
      executionMode: "host",
      recordedAt: "2026-04-19T00:00:00.000Z",
      leaseExpiresAt: "2026-04-19T00:30:00.000Z",
    });
    const issues: InMemoryIssue[] = [
      {
        number: 3,
        title: "Task with stale claim lease",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [
          {
            body: staleClaimComment,
            createdAt: "2026-04-19T00:00:00.000Z",
            author: { login: "sandcastle" },
          },
        ],
        url: "https://example.test/issues/3",
      },
      {
        number: 4,
        title: "Next ready Task",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/4",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-reclaim",
      now: () => new Date("2026-04-19T01:00:00.000Z"),
      executeTask: async ({ selectedTask }: ExecuteGitHubIssueTaskOptions) => ({
        branch: "main",
        commits: [{ sha: `commit-${selectedTask.issue.number}` }],
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(3);
    expect(result.closed).toBe(true);

    const reclaimedIssue = issues.find((issue) => issue.number === 3)!;
    const events = reclaimedIssue.comments
      .map((comment) => parseTaskCoordinationComment(comment.body))
      .filter((comment) => comment !== undefined);

    expect(events.map((comment) => comment.event)).toEqual([
      "claim",
      "reclaim",
      "claim",
      "done",
    ]);
    expect(events[1]).toMatchObject({
      runId: "run-reclaim",
      reclaimedClaimRunId: "run-stale-claim",
      reclaimedLeaseExpiresAt: "2026-04-19T00:30:00.000Z",
    });
    expect(events[2]?.leaseExpiresAt).toBeDefined();
  });

  it("does not reselect a landed GitHub Issue Task after done is recorded but issue closure fails", async () => {
    const issues: InMemoryIssue[] = [
      {
        number: 3,
        title: "Landed Task waiting on close retry",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/3",
      },
      {
        number: 4,
        title: "Next ready Task",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/4",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({
        issues,
        failCloseIssueNumbers: new Set([3]),
      }),
    });
    const executeTask = async ({
      selectedTask,
    }: ExecuteGitHubIssueTaskOptions) => ({
      branch: "main",
      commits: [{ sha: `commit-${selectedTask.issue.number}` }],
    });

    await expect(
      executeNextGitHubIssueTask({
        backlog,
        runId: "run-close-failure",
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        executeTask,
      }),
    ).rejects.toThrow("close failed for issue #3");

    const retryResult = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-after-close-failure",
      now: () => new Date("2026-04-19T00:01:00.000Z"),
      executeTask,
    });

    expect(retryResult.selectedTask?.issue.number).toBe(4);
    expect(retryResult.closed).toBe(true);

    const landedIssue = issues.find((issue) => issue.number === 3)!;
    const retryIssue = issues.find((issue) => issue.number === 4)!;

    expect(landedIssue.state).toBe("OPEN");
    expect(retryIssue.state).toBe("CLOSED");
    expect(
      landedIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined)
        .map((comment) => comment.event),
    ).toEqual(["claim", "done"]);
  });

  it("claims the selected issue before host execution, lands the change, and closes the issue only after land", async () => {
    const originalCwd = process.cwd();
    const hostDir = mkdtempSync(
      join(tmpdir(), "sandcastle-github-issue-host-"),
    );
    const binDir = mkdtempSync(join(tmpdir(), "sandcastle-github-issue-bin-"));
    const gitConfigDir = mkdtempSync(
      join(tmpdir(), "sandcastle-github-issue-gitcfg-"),
    );
    const globalConfigPath = join(gitConfigDir, ".gitconfig");
    const storePath = join(hostDir, "fake-gh-store.json");
    const eventsPath = join(hostDir, "events.log");

    writeFileSync(globalConfigPath, "");
    writeFileSync(eventsPath, "");
    writeFileSync(
      storePath,
      JSON.stringify(
        {
          issues: [
            {
              number: 1,
              title: "PRD: host-first Task Coordination core for GitHub Issues",
              body: "",
              state: "OPEN",
              labels: [],
              comments: [],
              url: "https://example.test/issues/1",
            },
            {
              number: 3,
              title: "GitHub Issue success path",
              body: "## Parent\\n\\n#1\\n",
              state: "OPEN",
              labels: ["ready-for-agent"],
              comments: [],
              url: "https://example.test/issues/3",
            },
          ],
        },
        null,
        2,
      ),
    );

    writeFakeGhCli({ binDir, storePath, eventsPath });

    execSync("git init -b main", { cwd: hostDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    writeFileSync(join(hostDir, "README.md"), "# Test\n");
    execSync("git add README.md", { cwd: hostDir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: hostDir, stdio: "ignore" });

    process.chdir(hostDir);

    const backlog = new GitHubIssueBacklog({
      cwd: hostDir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GH_STORE_PATH: storePath,
        FAKE_GH_EVENTS_PATH: eventsPath,
      },
    });

    try {
      const result = await executeNextGitHubIssueTask({
        backlog,
        runId: "run-issue-3",
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        executeTask: async ({ parentIssue }) => {
          expect(parentIssue?.number).toBe(1);

          return run({
            agent: makeHostFirstIssueAgent(eventsPath),
            sandbox: noSandbox({
              env: { GIT_CONFIG_GLOBAL: globalConfigPath },
            }),
            prompt: "Implement the selected GitHub Issue task.",
            logging: { type: "file", path: join(hostDir, "run.log") },
          });
        },
      });

      expect(result.selectedTask?.issue.number).toBe(3);
      expect(result.closed).toBe(true);
      expect(result.runResult?.commits).toHaveLength(1);
      expect(
        readFileSync(join(hostDir, "issue-task-output.txt"), "utf8"),
      ).toContain("implemented from selected issue");
      expect(
        execSync("git log --oneline --decorate", {
          cwd: hostDir,
          encoding: "utf8",
        }),
      ).toContain("host-first issue task commit");

      const store = JSON.parse(readFileSync(storePath, "utf8")) as {
        issues: Array<{
          number: number;
          state: string;
          comments: Array<{ body: string }>;
        }>;
      };
      const issue = store.issues.find((candidate) => candidate.number === 3)!;
      expect(issue.state).toBe("CLOSED");

      const events = issue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined);
      expect(events.map((comment) => comment.event)).toEqual(["claim", "done"]);

      const logLines = readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(logLines).toContain("comment:3:claim");
      expect(logLines).toContain("agent-start");
      expect(logLines).toContain("comment:3:done");
      expect(logLines).toContain("close:3:landed=yes");
      expect(logLines.indexOf("comment:3:claim")).toBeLessThan(
        logLines.indexOf("agent-start"),
      );
      expect(logLines.indexOf("agent-start")).toBeLessThan(
        logLines.indexOf("close:3:landed=yes"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(hostDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
      rmSync(gitConfigDir, { recursive: true, force: true });
    }
  });
});
