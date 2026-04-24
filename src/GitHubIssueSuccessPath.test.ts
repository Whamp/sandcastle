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
  TASK_COORDINATION_RESULT_TAG,
  type ExecuteGitHubIssueTaskOptions,
} from "./GitHubIssueSuccessPath.js";
import { run } from "./run.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

const shellEscape = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";

const makeHostFirstIssueAgentWithProposedFollowOn = (
  eventsPath: string,
  proposedFollowOn: {
    readonly title: string;
    readonly body: string;
  },
): AgentProvider => {
  const baseProvider = claudeCode("test-model");
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "working" }] },
  });
  const promptSupportsProposedFollowOn = (prompt: string): boolean =>
    [
      `<${TASK_COORDINATION_RESULT_TAG}>`,
      '"proposedFollowOn"',
      "Backlog Curation",
    ].every((snippet) => prompt.includes(snippet));

  return {
    name: "github-issue-success-path-agent-with-proposed-follow-on",
    env: {},
    captureSessions: false,
    buildPrintCommand: ({ prompt }) => {
      const resultLine = JSON.stringify({
        type: "result",
        result: promptSupportsProposedFollowOn(prompt)
          ? [
              `<${TASK_COORDINATION_RESULT_TAG}>`,
              JSON.stringify({ proposedFollowOn }),
              `</${TASK_COORDINATION_RESULT_TAG}>`,
              "<promise>COMPLETE</promise>",
            ].join("\n")
          : "<promise>COMPLETE</promise>",
      });

      return {
        command: [
          `printf '%s\\n' ${shellEscape(assistantLine)}`,
          `printf '%s\\n' ${shellEscape("agent-start")} >> ${shellEscape(eventsPath)}`,
          `echo 'implemented from selected issue' > ${shellEscape("issue-task-output.txt")}`,
          `git add ${shellEscape("issue-task-output.txt")}`,
          `git commit -m ${shellEscape("host-first issue task commit")}`,
          `printf '%s\\n' ${shellEscape(resultLine)}`,
        ].join(" && "),
      };
    },
    parseStreamLine: baseProvider.parseStreamLine,
  };
};

const makeHostFirstIssueAgentWithBlockedByPrerequisite = (
  eventsPath: string,
  blockedByPrerequisite: {
    readonly title: string;
    readonly body: string;
  },
): AgentProvider => {
  const baseProvider = claudeCode("test-model");
  const assistantLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "blocked on prerequisite" }] },
  });
  const promptSupportsBlockedByPrerequisite = (prompt: string): boolean =>
    [
      `<${TASK_COORDINATION_RESULT_TAG}>`,
      '"blockedByPrerequisite"',
      "blocking prerequisite Task",
    ].every((snippet) => prompt.includes(snippet));

  return {
    name: "github-issue-success-path-agent-with-blocked-by-prerequisite",
    env: {},
    captureSessions: false,
    buildPrintCommand: ({ prompt }) => {
      const resultLine = JSON.stringify({
        type: "result",
        result: promptSupportsBlockedByPrerequisite(prompt)
          ? [
              `<${TASK_COORDINATION_RESULT_TAG}>`,
              JSON.stringify({ blockedByPrerequisite }),
              `</${TASK_COORDINATION_RESULT_TAG}>`,
              "<promise>COMPLETE</promise>",
            ].join("\n")
          : "<promise>COMPLETE</promise>",
      });

      return {
        command: [
          `printf '%s\\n' ${shellEscape(assistantLine)}`,
          `printf '%s\\n' ${shellEscape("agent-start")} >> ${shellEscape(eventsPath)}`,
          `printf '%s\\n' ${shellEscape(resultLine)}`,
        ].join(" && "),
      };
    },
    parseStreamLine: baseProvider.parseStreamLine,
  };
};

interface InMemoryIssue {
  readonly number: number;
  readonly title: string;
  body: string;
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
  readonly failCreateIssueTitles?: ReadonlySet<string>;
}) => {
  const issuesByNumber = new Map(
    options.issues.map((issue) => [issue.number, issue]),
  );

  return async (args: string[]): Promise<string> => {
    if (args[0] === "label" && args[1] === "create") {
      return "";
    }

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

    if (args[1] === "create") {
      const titleIndex = args.indexOf("--title");
      const bodyIndex = args.indexOf("--body");
      const title = titleIndex >= 0 ? args[titleIndex + 1] : undefined;
      const body = bodyIndex >= 0 ? args[bodyIndex + 1] : undefined;
      const labels: string[] = [];

      for (let index = 2; index < args.length; index += 2) {
        if (args[index] === "--label" && args[index + 1]) {
          labels.push(args[index + 1]!);
        }
      }

      if (!title || body === undefined) {
        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }

      if (options.failCreateIssueTitles?.has(title)) {
        throw new Error(`create failed for issue title "${title}"`);
      }

      const number =
        Math.max(0, ...options.issues.map((issue) => issue.number)) + 1;
      const issue: InMemoryIssue = {
        number,
        title,
        body,
        state: "OPEN",
        labels,
        comments: [],
        url: `https://example.test/issues/${number}`,
      };

      options.issues.push(issue);
      issuesByNumber.set(number, issue);
      return `${issue.url}\n`;
    }

    if (args[1] === "edit") {
      const issue = issuesByNumber.get(Number(args[2]));
      if (!issue) {
        throw new Error(`Unknown issue #${args[2]}`);
      }

      for (let index = 3; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value) {
          throw new Error(`Unsupported gh args: ${args.join(" ")}`);
        }

        if (flag === "--add-label" && !issue.labels.includes(value)) {
          issue.labels.push(value);
          continue;
        }

        if (flag === "--remove-label") {
          const labelIndex = issue.labels.indexOf(value);
          if (labelIndex >= 0) {
            issue.labels.splice(labelIndex, 1);
          }
          continue;
        }

        if (flag === "--body") {
          issue.body = value;
          continue;
        }

        throw new Error(`Unsupported gh args: ${args.join(" ")}`);
      }

      return "";
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

if (normalizedArgs[1] === "create") {
  const titleIndex = normalizedArgs.indexOf("--title");
  const bodyIndex = normalizedArgs.indexOf("--body");
  const title = titleIndex >= 0 ? normalizedArgs[titleIndex + 1] : undefined;
  const body = bodyIndex >= 0 ? normalizedArgs[bodyIndex + 1] : undefined;
  const labels = [];

  for (let index = 2; index < normalizedArgs.length; index += 2) {
    if (normalizedArgs[index] === "--label" && normalizedArgs[index + 1]) {
      labels.push(normalizedArgs[index + 1]);
    }
  }

  if (!title || body === undefined) {
    throw new Error("Unsupported gh command: " + normalizedArgs.join(" "));
  }

  const number = Math.max(0, ...store.issues.map((issue) => issue.number)) + 1;
  const issue = {
    number,
    title,
    body,
    state: "OPEN",
    labels,
    comments: [],
    url: "https://example.test/issues/" + number,
  };

  store.issues.push(issue);
  writeStore(store);
  log("create:" + number + ":labels=" + (labels.join(",") || "none"));
  process.stdout.write(issue.url + "\\n");
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

  it("creates a blocking prerequisite GitHub Issue, releases the current claim, and reselects the current Task only after the prerequisite closes", async () => {
    const issues: InMemoryIssue[] = [
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
        number: 7,
        title: "Current Task with newly discovered prerequisite work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task after prerequisite work is ready.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/7",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-blocked-by-prerequisite",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [],
        blockedByPrerequisite: {
          title: "Add the GitHub Issue body patch helper first",
          body: "## What to build\n\nCreate the issue body patch helper that the current Task now depends on.\n",
        },
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(7);
    expect(result.closed).toBe(false);
    expect(result.blockingPrerequisiteTask).toMatchObject({
      issue: {
        number: 8,
        title: "Add the GitHub Issue body patch helper first",
        state: "OPEN",
        labels: ["ready-for-agent"],
      },
      parentIssueNumber: 1,
      followOnFromIssueNumber: 7,
      dependencies: [],
    });

    const currentIssue = issues.find((issue) => issue.number === 7)!;
    const prerequisiteIssue = issues.find((issue) => issue.number === 8)!;
    const currentEvents = currentIssue.comments
      .map((comment) => parseTaskCoordinationComment(comment.body))
      .filter((comment) => comment !== undefined);

    expect(prerequisiteIssue.body).toContain("## Parent\n\n#1");
    expect(prerequisiteIssue.body).toContain(
      "## Follow-on from\n\n- Follow-on from #7",
    );
    expect(currentIssue.body).toContain("## Blocked by\n\n- Blocked by #8");
    expect(currentIssue.labels).toEqual(["ready-for-agent"]);
    expect(currentEvents.map((comment) => comment.event)).toEqual([
      "claim",
      "release",
    ]);
    expect(currentEvents[1]).toMatchObject({
      runId: "run-blocked-by-prerequisite",
      reason: "Discovered blocking prerequisite #8.",
    });
    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(8);

    prerequisiteIssue.state = "CLOSED";

    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(7);
  });

  it("treats landed commits as done even when a blocked-by-prerequisite marker is present", async () => {
    const issues: InMemoryIssue[] = [
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
        number: 7,
        title: "Current Task that already landed changes",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task before any new prerequisite metadata is recorded.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/7",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-landed-marker-wins",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [{ sha: "commit-7" }],
        blockedByPrerequisite: {
          title: "Add the GitHub Issue body patch helper first",
          body: "## What to build\n\nCreate the issue body patch helper that the current Task now depends on.\n",
        },
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(7);
    expect(result.closed).toBe(true);
    expect(result.blockingPrerequisiteTask).toBeUndefined();

    const currentIssue = issues.find((issue) => issue.number === 7)!;
    expect(currentIssue.state).toBe("CLOSED");
    expect(currentIssue.body).not.toContain("## Blocked by");
    expect(issues).toHaveLength(2);
    expect(
      currentIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined)
        .map((comment) => comment.event),
    ).toEqual(["claim", "done"]);
  });

  it("creates a proposed follow-on issue from the additive result hook while still closing the current Task", async () => {
    const issues: InMemoryIssue[] = [
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
        number: 7,
        title: "Current Task with non-blocking follow-on work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task before Backlog Curation promotes anything else.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/7",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-proposed-follow-on",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [{ sha: "commit-7" }],
        proposedFollowOn: {
          title: "Document the upstream promotion checkpoint",
          body: "## What to build\n\nCapture the upstream promotion decision for the proposed Task.\n",
        },
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(7);
    expect(result.closed).toBe(true);
    expect(result.proposedFollowOnTask).toMatchObject({
      issue: {
        number: 8,
        title: "Document the upstream promotion checkpoint",
        state: "OPEN",
        labels: [],
      },
      parentIssueNumber: 1,
      followOnFromIssueNumber: 7,
      dependencies: [],
    });

    const currentIssue = issues.find((issue) => issue.number === 7)!;
    const proposedIssue = issues.find((issue) => issue.number === 8)!;

    expect(currentIssue.state).toBe("CLOSED");
    expect(currentIssue.body).not.toContain("## Blocked by");
    expect(proposedIssue.body).toContain("## Parent\n\n#1");
    expect(proposedIssue.body).toContain(
      "## Follow-on from\n\n- Follow-on from #7",
    );
    expect(await backlog.selectNextReadyTask()).toBeUndefined();

    proposedIssue.labels.push("ready-for-agent");
    expect((await backlog.selectNextReadyTask())?.issue.number).toBe(8);
  });

  it("treats proposed follow-on creation as best-effort so a landed Task still records done and closes", async () => {
    const issues: InMemoryIssue[] = [
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
        number: 7,
        title: "Current Task with non-blocking follow-on work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task before Backlog Curation promotes anything else.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/7",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({
        issues,
        failCreateIssueTitles: new Set([
          "Document the upstream promotion checkpoint",
        ]),
      }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-proposed-follow-on-create-failure",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [{ sha: "commit-7" }],
        proposedFollowOn: {
          title: "Document the upstream promotion checkpoint",
          body: "## What to build\n\nCapture the upstream promotion decision for the proposed Task.\n",
        },
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(7);
    expect(result.closed).toBe(true);
    expect(result.proposedFollowOnTask).toBeUndefined();
    expect(result.proposedFollowOnError).toBe(
      'create failed for issue title "Document the upstream promotion checkpoint"',
    );

    const currentIssue = issues.find((issue) => issue.number === 7)!;
    expect(currentIssue.state).toBe("CLOSED");
    expect(issues).toHaveLength(2);
    expect(
      currentIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined)
        .map((comment) => comment.event),
    ).toEqual(["claim", "done"]);
  });

  it("treats proposed follow-on creation as best-effort so a non-landed Task still releases its claim", async () => {
    const issues: InMemoryIssue[] = [
      {
        number: 3,
        title: "Task without a landed change",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/3",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({
        issues,
        failCreateIssueTitles: new Set([
          "Document the upstream promotion checkpoint",
        ]),
      }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-proposed-follow-on-release-create-failure",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [],
        proposedFollowOn: {
          title: "Document the upstream promotion checkpoint",
          body: "## What to build\n\nCapture the upstream promotion decision for the proposed Task.\n",
        },
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(3);
    expect(result.closed).toBe(false);
    expect(result.proposedFollowOnTask).toBeUndefined();
    expect(result.proposedFollowOnError).toBe(
      'create failed for issue title "Document the upstream promotion checkpoint"',
    );

    const currentIssue = issues.find((issue) => issue.number === 3)!;
    expect(currentIssue.state).toBe("OPEN");
    expect(issues).toHaveLength(1);
    expect(
      currentIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined)
        .map((comment) => comment.event),
    ).toEqual(["claim", "release"]);
  });

  it("records release for a non-landed execution instead of treating it as dependency-blocked", async () => {
    const issues: InMemoryIssue[] = [
      {
        number: 3,
        title: "Task without a landed change",
        body: "",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/3",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });
    const result = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-release",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      executeTask: async () => ({
        branch: "main",
        commits: [],
      }),
    });

    expect(result.selectedTask?.issue.number).toBe(3);
    expect(result.closed).toBe(false);

    const releaseIssue = issues.find((issue) => issue.number === 3)!;
    expect(releaseIssue.state).toBe("OPEN");
    expect(
      releaseIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined)
        .map((comment) => comment.event),
    ).toEqual(["claim", "release"]);
  });

  it("records needs-attention through GitHub-visible labels, releases the claim, and allows recovery after human relabeling", async () => {
    const issues: InMemoryIssue[] = [
      {
        number: 3,
        title: "Task requiring intervention after execution failure",
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
    const executionFailure = new Error(
      "Manual intervention required to restore host execution.",
    );

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });

    await expect(
      executeNextGitHubIssueTask({
        backlog,
        runId: "run-needs-attention",
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        executeTask: async () => {
          throw executionFailure;
        },
      }),
    ).rejects.toBe(executionFailure);

    const needsAttentionIssue = issues.find((issue) => issue.number === 3)!;
    expect(needsAttentionIssue.state).toBe("OPEN");
    expect(needsAttentionIssue.labels).toEqual(["needs-attention"]);

    const events = needsAttentionIssue.comments
      .map((comment) => parseTaskCoordinationComment(comment.body))
      .filter((comment) => comment !== undefined);
    expect(events.map((comment) => comment.event)).toEqual([
      "claim",
      "needs-attention",
    ]);
    expect(events[1]).toMatchObject({
      runId: "run-needs-attention",
      reason: executionFailure.message,
    });

    const retryResult = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-after-needs-attention",
      now: () => new Date("2026-04-19T00:01:00.000Z"),
      executeTask: async ({ selectedTask }: ExecuteGitHubIssueTaskOptions) => ({
        branch: "main",
        commits: [{ sha: `commit-${selectedTask.issue.number}` }],
      }),
    });

    expect(retryResult.selectedTask?.issue.number).toBe(4);
    expect(retryResult.closed).toBe(true);

    needsAttentionIssue.labels.splice(
      0,
      needsAttentionIssue.labels.length,
      "ready-for-agent",
    );

    const recoveryResult = await executeNextGitHubIssueTask({
      backlog,
      runId: "run-after-human-recovery",
      now: () => new Date("2026-04-19T00:02:00.000Z"),
      executeTask: async ({ selectedTask }: ExecuteGitHubIssueTaskOptions) => ({
        branch: "main",
        commits: [{ sha: `commit-${selectedTask.issue.number}` }],
      }),
    });

    expect(recoveryResult.selectedTask?.issue.number).toBe(3);
    expect(recoveryResult.closed).toBe(true);
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

  it("claims the selected issue before host execution, uses the repo-local implement prompt to emit a blocked-by-prerequisite result tag, and keeps the current Task blocked until the prerequisite closes", async () => {
    const originalCwd = process.cwd();
    const repoImplementPromptPath = join(
      originalCwd,
      ".sandcastle",
      "implement-prompt.md",
    );
    const hostDir = mkdtempSync(
      join(tmpdir(), "sandcastle-github-issue-host-blocked-"),
    );
    const gitConfigDir = mkdtempSync(
      join(tmpdir(), "sandcastle-github-issue-gitcfg-"),
    );
    const globalConfigPath = join(gitConfigDir, ".gitconfig");
    const eventsPath = join(hostDir, "events.log");

    writeFileSync(globalConfigPath, "");
    writeFileSync(eventsPath, "");
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

    const issues: InMemoryIssue[] = [
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
        number: 7,
        title: "Current Task with newly discovered prerequisite work",
        body: "## Parent\n\n#1\n\n## What to build\n\nLand the current Task after prerequisite work is ready.\n",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [],
        url: "https://example.test/issues/7",
      },
    ];

    const backlog = new GitHubIssueBacklog({
      gh: createInMemoryGh({ issues }),
    });

    try {
      const result = await executeNextGitHubIssueTask({
        backlog,
        runId: "run-blocked-issue-7",
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        executeTask: async ({ parentIssue }) => {
          expect(parentIssue?.number).toBe(1);

          return run({
            agent: makeHostFirstIssueAgentWithBlockedByPrerequisite(
              eventsPath,
              {
                title: "Add the GitHub Issue body patch helper first",
                body: "## What to build\n\nCreate the issue body patch helper that the current Task now depends on.\n",
              },
            ),
            sandbox: noSandbox({
              env: { GIT_CONFIG_GLOBAL: globalConfigPath },
            }),
            name: "Task-7-blocked",
            promptFile: repoImplementPromptPath,
            promptArgs: {
              ISSUE_NUMBER: "7",
              ISSUE_TITLE:
                "Current Task with newly discovered prerequisite work",
              PARENT_ISSUE_NUMBER: "1",
              PARENT_ISSUE_TITLE:
                "PRD: host-first Task Coordination core for GitHub Issues",
            },
            logging: { type: "file", path: join(hostDir, "run.log") },
          });
        },
      });

      expect(result.selectedTask?.issue.number).toBe(7);
      expect(result.closed).toBe(false);
      expect(result.blockingPrerequisiteTask).toMatchObject({
        issue: {
          number: 8,
          title: "Add the GitHub Issue body patch helper first",
          state: "OPEN",
          labels: ["ready-for-agent"],
        },
        parentIssueNumber: 1,
        followOnFromIssueNumber: 7,
        dependencies: [],
      });

      const currentIssue = issues.find((issue) => issue.number === 7)!;
      const prerequisiteIssue = issues.find((issue) => issue.number === 8)!;
      const currentEvents = currentIssue.comments
        .map((comment) => parseTaskCoordinationComment(comment.body))
        .filter((comment) => comment !== undefined);

      expect(prerequisiteIssue.body).toContain("## Parent\n\n#1");
      expect(prerequisiteIssue.body).toContain(
        "## Follow-on from\n\n- Follow-on from #7",
      );
      expect(currentIssue.body).toContain("## Blocked by\n\n- Blocked by #8");
      expect(currentEvents.map((comment) => comment.event)).toEqual([
        "claim",
        "release",
      ]);
      expect((await backlog.selectNextReadyTask())?.issue.number).toBe(8);

      prerequisiteIssue.state = "CLOSED";
      expect((await backlog.selectNextReadyTask())?.issue.number).toBe(7);
      expect(
        execSync("git rev-list --count HEAD", {
          cwd: hostDir,
          encoding: "utf8",
        }).trim(),
      ).toBe("1");
    } finally {
      process.chdir(originalCwd);
      rmSync(hostDir, { recursive: true, force: true });
      rmSync(gitConfigDir, { recursive: true, force: true });
    }
  });

  it("claims the selected issue before host execution, uses the repo-local implement prompt to emit a proposed follow-on result tag, and still closes the current issue only after land", async () => {
    const originalCwd = process.cwd();
    const repoImplementPromptPath = join(
      originalCwd,
      ".sandcastle",
      "implement-prompt.md",
    );
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
            agent: makeHostFirstIssueAgentWithProposedFollowOn(eventsPath, {
              title: "Document the proposed follow-on Task outcome",
              body: "## What to build\n\nCapture how Task Coordination returns proposed work to Backlog Curation.\n",
            }),
            sandbox: noSandbox({
              env: { GIT_CONFIG_GLOBAL: globalConfigPath },
            }),
            name: "Task-3",
            promptFile: repoImplementPromptPath,
            promptArgs: {
              ISSUE_NUMBER: "3",
              ISSUE_TITLE: "GitHub Issue success path",
              PARENT_ISSUE_NUMBER: "1",
              PARENT_ISSUE_TITLE:
                "PRD: host-first Task Coordination core for GitHub Issues",
            },
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
          body: string;
          state: string;
          labels: string[];
          comments: Array<{ body: string }>;
        }>;
      };
      const issue = store.issues.find((candidate) => candidate.number === 3)!;
      const proposedIssue = store.issues.find(
        (candidate) => candidate.number === 4,
      )!;
      expect(issue.state).toBe("CLOSED");
      expect(proposedIssue.state).toBe("OPEN");
      expect(proposedIssue.labels).toEqual([]);

      const normalizedProposedBody = proposedIssue.body.replaceAll("\\n", "\n");
      expect(normalizedProposedBody).toContain("## Parent");
      expect(normalizedProposedBody).toContain("#1");
      expect(normalizedProposedBody).toContain("## Follow-on from");
      expect(normalizedProposedBody).toContain("- Follow-on from #3");
      expect(await backlog.selectNextReadyTask()).toBeUndefined();

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
      expect(logLines).toContain("create:4:labels=none");
      expect(logLines).toContain("comment:3:done");
      expect(logLines).toContain("close:3:landed=yes");
      expect(logLines.indexOf("comment:3:claim")).toBeLessThan(
        logLines.indexOf("agent-start"),
      );
      expect(logLines.indexOf("agent-start")).toBeLessThan(
        logLines.indexOf("create:4:labels=none"),
      );
      expect(logLines.indexOf("create:4:labels=none")).toBeLessThan(
        logLines.indexOf("comment:3:done"),
      );
      expect(logLines.indexOf("comment:3:done")).toBeLessThan(
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
