import { describe, expect, it } from "vitest";
import {
  coordinateImplementation,
  type CoordinationPullRequest,
  type ImplementationCoordinationPullRequestPort,
  type ParentEffort,
  type ParentRef,
  type ScopedTask,
} from "./ImplementationCoordination.js";

describe("coordinateImplementation", () => {
  it("loads a parent effort, reports no completed tasks, and does not publish a PR when no scoped tasks exist", async () => {
    const parentRef: ParentRef = { type: "github-issue", issueNumber: 11 };
    const parent: ParentEffort = {
      id: "parent-11",
      title: "Parent scoped implementation effort",
    };
    const scopedTasks: ScopedTask[] = [];
    const publishedPullRequests: unknown[] = [];
    const pullRequests: ImplementationCoordinationPullRequestPort = {
      async createOrUpdate(options): Promise<CoordinationPullRequest> {
        publishedPullRequests.push(options);
        return { url: "https://example.test/pr/1" };
      },
    };

    const result = await coordinateImplementation({
      parent: parentRef,
      ports: {
        backlog: {
          async loadParent(ref) {
            expect(ref).toEqual(parentRef);
            return parent;
          },
          async listScopedTasks(loadedParent) {
            expect(loadedParent).toBe(parent);
            return scopedTasks;
          },
        },
        pullRequests,
      },
    });

    expect(result.parent).toBe(parent);
    expect(result.scopedTasks).toEqual([]);
    expect(result.completedTasks).toEqual([]);
    expect(result.pullRequest).toBeUndefined();
    expect(result.noPullRequestReason).toContain(
      "no issue branch was accepted",
    );
    expect(result.mergeRecommendation).toBe("do-not-recommend-merge-yet");
    expect(publishedPullRequests).toEqual([]);
  });
});
