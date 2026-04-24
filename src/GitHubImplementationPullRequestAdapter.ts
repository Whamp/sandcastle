import { execFile } from "node:child_process";
import type {
  CoordinationPullRequest,
  CreateOrUpdateCoordinationPullRequestOptions,
  ImplementationCoordinationPullRequestPort,
} from "./ImplementationCoordination.js";
import { NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON } from "./ImplementationCoordination.js";
import { renderImplementationCoordinationReport } from "./ImplementationCoordinationReport.js";
import type { GitHubCommandRunner } from "./GitHubIssueBacklog.js";

export { renderImplementationCoordinationReport } from "./ImplementationCoordinationReport.js";

export interface GitHubImplementationPullRequestAdapterOptions {
  readonly cwd?: string;
  readonly repo?: string;
  readonly env?: Record<string, string>;
  readonly gh?: GitHubCommandRunner;
  readonly baseBranch?: string;
  readonly draft?: boolean;
}

interface GitHubPullRequestListItem {
  readonly number: number;
  readonly url: string;
}

const withRepo = (args: string[], repo?: string): string[] =>
  repo ? [...args, "--repo", repo] : args;

const execGh = async (
  args: string[],
  options?: Pick<GitHubImplementationPullRequestAdapterOptions, "cwd" | "env">,
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

const parseCreatedPullRequestUrl = (output: string): string => {
  const url = output
    .trim()
    .split(/\s+/)
    .find((token) => token.length > 0);
  if (!url) {
    throw new Error("Unable to parse created pull request URL from gh output.");
  }

  return url;
};

const buildTitle = (
  options: Pick<CreateOrUpdateCoordinationPullRequestOptions, "parent">,
): string =>
  `Implementation coordination: ${options.parent.title ?? options.parent.id}`;

export class GitHubImplementationPullRequestAdapter implements ImplementationCoordinationPullRequestPort {
  readonly #gh: GitHubCommandRunner;
  readonly #repo?: string;
  readonly #baseBranch: string;
  readonly #draft: boolean;

  constructor(options: GitHubImplementationPullRequestAdapterOptions = {}) {
    this.#repo = options.repo;
    this.#baseBranch = options.baseBranch ?? "main";
    this.#draft = options.draft ?? false;
    this.#gh =
      options.gh ??
      ((args) =>
        execGh(withRepo(args, this.#repo), {
          cwd: options.cwd,
          env: options.env,
        }));
  }

  async createOrUpdate(
    options: CreateOrUpdateCoordinationPullRequestOptions,
  ): Promise<CoordinationPullRequest> {
    if (options.completedTasks.length === 0) {
      throw new Error(NO_ACCEPTED_ISSUE_BRANCH_NO_PR_REASON);
    }

    const headBranch = options.coordinatorWorkspace?.branch;
    if (!headBranch) {
      throw new Error(
        "Cannot publish an implementation coordination PR without a coordinator branch.",
      );
    }

    const body =
      options.body || renderImplementationCoordinationReport(options);
    const title = buildTitle(options);
    const existingPullRequests = JSON.parse(
      await this.#gh([
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        headBranch,
        "--json",
        "number,url",
      ]),
    ) as GitHubPullRequestListItem[];
    const existingPullRequest = existingPullRequests[0];

    if (existingPullRequest) {
      await this.#gh([
        "pr",
        "edit",
        String(existingPullRequest.number),
        "--title",
        title,
        "--body",
        body,
      ]);
      return {
        id: String(existingPullRequest.number),
        url: existingPullRequest.url,
        body,
      };
    }

    const args = [
      "pr",
      "create",
      "--head",
      headBranch,
      "--base",
      this.#baseBranch,
      "--title",
      title,
      "--body",
      body,
    ];
    if (this.#draft) {
      args.push("--draft");
    }

    const url = parseCreatedPullRequestUrl(await this.#gh(args));
    return { url, body };
  }
}
