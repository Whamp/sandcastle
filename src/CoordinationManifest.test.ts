import { describe, expect, it } from "vitest";
import {
  parseCoordinationManifestFromBody,
  renderCoordinationManifest,
  upsertCoordinationManifest,
} from "./CoordinationManifest.js";

const manifestOptions = {
  parent: { id: "#21", title: "Integration Finalization" },
  coordinatorBranch: "sandcastle/coordinator/21",
  targetBranch: "main",
  baseBranch: "main",
  acceptedForIntegrationTasks: [
    {
      task: { id: "#22", title: "Add coordination manifest" },
      branch: "sandcastle/task/22-coordination-manifest",
    },
  ],
  mergeRecommendation: "recommend-merge" as const,
  publishedAt: "2026-04-24T10:00:00.000Z",
};

describe("Sandcastle coordination manifest", () => {
  it("renders and parses a versioned coordination manifest for accepted-for-integration tasks", () => {
    const body = renderCoordinationManifest(manifestOptions);

    const manifest = parseCoordinationManifestFromBody(body);

    expect(manifest).toEqual({
      kind: "sandcastle.coordination-manifest",
      version: 1,
      parentScope: {
        id: "#21",
        issueNumber: 21,
        title: "Integration Finalization",
      },
      coordinatorBranch: "sandcastle/coordinator/21",
      targetBranch: "main",
      baseBranch: "main",
      acceptedTasks: [
        {
          id: "#22",
          issueNumber: 22,
          title: "Add coordination manifest",
          branch: "sandcastle/task/22-coordination-manifest",
        },
      ],
      publication: {
        publisher: "sandcastle",
        publishedAt: "2026-04-24T10:00:00.000Z",
        mergeRecommendation: "recommend-merge",
        acceptedTaskCount: 1,
      },
    });
  });

  it("rejects invalid manifests and unsupported versions", () => {
    const invalidJson = [
      "<!-- sandcastle:coordination-manifest:start -->",
      "```json",
      "{not-json}",
      "```",
      "<!-- sandcastle:coordination-manifest:end -->",
    ].join("\n");
    const missingRequiredField = [
      "<!-- sandcastle:coordination-manifest:start -->",
      "```json",
      JSON.stringify({
        kind: "sandcastle.coordination-manifest",
        version: 1,
        parentScope: { id: "#21" },
        targetBranch: "main",
        baseBranch: "main",
        acceptedTasks: [],
        publication: {
          publisher: "sandcastle",
          publishedAt: "2026-04-24T10:00:00.000Z",
          mergeRecommendation: "recommend-merge",
          acceptedTaskCount: 0,
        },
      }),
      "```",
      "<!-- sandcastle:coordination-manifest:end -->",
    ].join("\n");
    const unsupportedVersion = [
      "<!-- sandcastle:coordination-manifest:start -->",
      "```json",
      JSON.stringify({
        kind: "sandcastle.coordination-manifest",
        version: 2,
      }),
      "```",
      "<!-- sandcastle:coordination-manifest:end -->",
    ].join("\n");
    const invalidMergeRecommendation = renderCoordinationManifest(
      manifestOptions,
    ).replace(
      '"mergeRecommendation": "recommend-merge"',
      '"mergeRecommendation": "done"',
    );
    const invalidPublisher = renderCoordinationManifest(
      manifestOptions,
    ).replace('"publisher": "sandcastle"', '"publisher": "other-tool"');
    const missingAcceptedTaskCount = renderCoordinationManifest(
      manifestOptions,
    ).replace(/,\n    "acceptedTaskCount": 1/, "");
    const mismatchedAcceptedTaskCount = renderCoordinationManifest(
      manifestOptions,
    ).replace('"acceptedTaskCount": 1', '"acceptedTaskCount": 99');

    expect(() => parseCoordinationManifestFromBody(invalidJson)).toThrow(
      "JSON could not be parsed",
    );
    expect(() =>
      parseCoordinationManifestFromBody(missingRequiredField),
    ).toThrow("coordinatorBranch is required");
    expect(() => parseCoordinationManifestFromBody(unsupportedVersion)).toThrow(
      "Unsupported Sandcastle coordination manifest version: 2",
    );
    expect(() =>
      parseCoordinationManifestFromBody(invalidMergeRecommendation),
    ).toThrow("publication.mergeRecommendation is invalid");
    expect(() => parseCoordinationManifestFromBody(invalidPublisher)).toThrow(
      "publication.publisher is invalid",
    );
    expect(() =>
      parseCoordinationManifestFromBody(missingAcceptedTaskCount),
    ).toThrow("publication.acceptedTaskCount is required");
    expect(() =>
      parseCoordinationManifestFromBody(mismatchedAcceptedTaskCount),
    ).toThrow("publication.acceptedTaskCount does not match acceptedTasks");
  });

  it("accepts unknown future fields in a supported v1 manifest", () => {
    const body = renderCoordinationManifest(manifestOptions).replace(
      '"publication": {',
      '"futureTopLevelField": { "ignored": true },\n  "publication": {\n    "futurePublicationField": "ignored",',
    );

    const manifest = parseCoordinationManifestFromBody(body);

    expect(manifest?.publication.publishedAt).toBe("2026-04-24T10:00:00.000Z");
    expect(manifest?.acceptedTasks).toHaveLength(1);
  });

  it("preserves the human-readable coordination report and replaces stale manifests without duplicates", () => {
    const staleManifest = renderCoordinationManifest({
      ...manifestOptions,
      acceptedForIntegrationTasks: [
        {
          task: { id: "#999", title: "Stale task" },
          branch: "stale/task",
        },
      ],
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    const humanReport = [
      "# Implementation coordination report: Integration Finalization",
      "",
      "## Accepted for integration tasks",
      "- Add coordination manifest (#22) on sandcastle/task/22-coordination-manifest",
    ].join("\n");
    const bodyWithDuplicateStaleManifests = [
      humanReport,
      staleManifest,
      staleManifest,
    ].join("\n\n");

    const updatedBody = upsertCoordinationManifest(
      bodyWithDuplicateStaleManifests,
      manifestOptions,
    );

    expect(updatedBody).toContain(humanReport);
    expect(
      updatedBody.match(/sandcastle:coordination-manifest:start/g),
    ).toHaveLength(1);
    expect(updatedBody).not.toContain("#999");
    expect(
      parseCoordinationManifestFromBody(updatedBody)?.acceptedTasks,
    ).toEqual([
      {
        id: "#22",
        issueNumber: 22,
        title: "Add coordination manifest",
        branch: "sandcastle/task/22-coordination-manifest",
      },
    ]);
  });
});
