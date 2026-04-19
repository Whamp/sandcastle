import { execFile } from "node:child_process";

export interface GitHubIssueComment {
  readonly body: string;
  readonly createdAt?: string;
  readonly author?: { readonly login: string };
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly comments: GitHubIssueComment[];
  readonly url?: string;
}

export interface GitHubIssueTask {
  readonly issue: GitHubIssue;
  readonly parentIssueNumber?: number;
}

export type TaskCoordinationCommentEvent = "claim" | "release" | "done";

export interface TaskCoordinationComment {
  readonly kind: "sandcastle-task-coordination";
  readonly version: 1;
  readonly event: TaskCoordinationCommentEvent;
  readonly runId: string;
  readonly executionMode: "host" | "sandboxed";
  readonly recordedAt: string;
  readonly branch?: string;
  readonly commits?: string[];
  readonly reason?: string;
}

export type GitHubCommandRunner = (args: string[]) => Promise<string>;

export interface GitHubIssueBacklogOptions {
  readonly cwd?: string;
  readonly repo?: string;
  readonly env?: Record<string, string>;
  readonly gh?: GitHubCommandRunner;
}

const execGh = async (
  args: string[],
  options?: Pick<GitHubIssueBacklogOptions, "cwd" | "env">,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        resolve(stdout.toString());
      },
    );
  });

const withRepo = (args: string[], repo?: string): string[] =>
  repo ? [...args, "--repo", repo] : args;

const parseSection = (body: string, heading: string): string | undefined => {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(
      `## ${escapedHeading}\\s*([\\s\\S]*?)(?=\\n##\\s+[^\\n]+|$)`,
      "i",
    ),
  );

  return match?.[1]?.trim();
};

const parseIssueReferences = (text?: string): number[] => {
  if (!text) return [];

  return Array.from(text.matchAll(/#(\d+)/g), (match) => Number(match[1]));
};

export const parseParentIssueNumber = (body: string): number | undefined =>
  parseIssueReferences(parseSection(body, "Parent"))[0];

export const parseBlockedByIssueNumbers = (body: string): number[] =>
  parseIssueReferences(parseSection(body, "Blocked by"));

export const isPrdIssue = (issue: Pick<GitHubIssue, "title">): boolean =>
  issue.title.trim().toLowerCase().startsWith("prd:");

export const formatTaskCoordinationComment = (
  comment: TaskCoordinationComment,
): string => {
  const headline =
    comment.event === "claim"
      ? "Sandcastle Task Coordination claim"
      : comment.event === "release"
        ? "Sandcastle Task Coordination release"
        : "Sandcastle Task Coordination done";

  const executionLabel =
    comment.executionMode === "host" ? "host execution" : "sandboxed execution";
  const description =
    comment.event === "claim"
      ? `This GitHub Issue is the selected Task for the current ${executionLabel}.`
      : comment.event === "release"
        ? "This GitHub Issue Task claim has been released."
        : "This GitHub Issue Task has landed through Task Coordination and is ready for closure.";

  return `${headline}\n\n${description}\n\n\`\`\`json\n${JSON.stringify(comment, null, 2)}\n\`\`\``;
};

export const parseTaskCoordinationComment = (
  body: string,
): TaskCoordinationComment | undefined => {
  if (!body.includes("sandcastle-task-coordination")) {
    return undefined;
  }

  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]!) as Partial<TaskCoordinationComment>;
    if (
      parsed.kind !== "sandcastle-task-coordination" ||
      parsed.version !== 1 ||
      (parsed.event !== "claim" &&
        parsed.event !== "release" &&
        parsed.event !== "done") ||
      (parsed.executionMode !== "host" &&
        parsed.executionMode !== "sandboxed") ||
      typeof parsed.runId !== "string" ||
      typeof parsed.recordedAt !== "string"
    ) {
      return undefined;
    }

    return parsed as TaskCoordinationComment;
  } catch {
    return undefined;
  }
};

export const hasRecordedTaskCoordinationDone = (
  comments: readonly GitHubIssueComment[],
): boolean =>
  comments.some(
    (comment) => parseTaskCoordinationComment(comment.body)?.event === "done",
  );

export const hasUnresolvedTaskCoordinationClaim = (
  comments: readonly GitHubIssueComment[],
): boolean => {
  let latestEvent: TaskCoordinationCommentEvent | undefined;

  for (const comment of comments) {
    const parsed = parseTaskCoordinationComment(comment.body);
    if (parsed) {
      latestEvent = parsed.event;
    }
  }

  return latestEvent === "claim";
};

export class GitHubIssueBacklog {
  readonly #cwd?: string;
  readonly #repo?: string;
  readonly #env?: Record<string, string>;
  readonly #gh: GitHubCommandRunner;

  constructor(options: GitHubIssueBacklogOptions = {}) {
    this.#cwd = options.cwd;
    this.#repo = options.repo;
    this.#env = options.env;
    this.#gh =
      options.gh ??
      ((args) =>
        execGh(withRepo(args, this.#repo), {
          cwd: this.#cwd,
          env: this.#env,
        }));
  }

  async listReadyIssues(): Promise<
    Array<Pick<GitHubIssue, "number" | "title">>
  > {
    return JSON.parse(
      await this.#gh([
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "ready-for-agent",
        "--limit",
        "100",
        "--json",
        "number,title",
      ]),
    ) as Array<Pick<GitHubIssue, "number" | "title">>;
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return JSON.parse(
      await this.#gh([
        "issue",
        "view",
        String(number),
        "--json",
        "number,title,body,state,comments,url",
      ]),
    ) as GitHubIssue;
  }

  async selectNextReadyTask(): Promise<GitHubIssueTask | undefined> {
    const readyIssues = await this.listReadyIssues();
    const orderedIssueNumbers = readyIssues
      .map((issue) => issue.number)
      .sort((left, right) => left - right);

    for (const issueNumber of orderedIssueNumbers) {
      const issue = await this.getIssue(issueNumber);
      if (isPrdIssue(issue)) {
        continue;
      }

      if (hasRecordedTaskCoordinationDone(issue.comments)) {
        continue;
      }

      if (hasUnresolvedTaskCoordinationClaim(issue.comments)) {
        continue;
      }

      const blockerNumbers = parseBlockedByIssueNumbers(issue.body);
      if (blockerNumbers.length > 0) {
        const blockerStates = await Promise.all(
          blockerNumbers.map(
            async (blockerNumber) => (await this.getIssue(blockerNumber)).state,
          ),
        );

        if (blockerStates.includes("OPEN")) {
          continue;
        }
      }

      return {
        issue,
        parentIssueNumber: parseParentIssueNumber(issue.body),
      };
    }

    return undefined;
  }

  async claimTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async releaseTask(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async markTaskDone(
    issueNumber: number,
    comment: TaskCoordinationComment,
  ): Promise<void> {
    await this.commentOnIssue(
      issueNumber,
      formatTaskCoordinationComment(comment),
    );
  }

  async closeTask(issueNumber: number): Promise<void> {
    await this.#gh(["issue", "close", String(issueNumber)]);
  }

  private async commentOnIssue(
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.#gh(["issue", "comment", String(issueNumber), "--body", body]);
  }
}
