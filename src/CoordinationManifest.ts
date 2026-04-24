import type {
  AcceptedForIntegrationTask,
  MergeRecommendation,
  ParentEffort,
} from "./ImplementationCoordination.js";

export const COORDINATION_MANIFEST_KIND =
  "sandcastle.coordination-manifest" as const;
export const COORDINATION_MANIFEST_VERSION = 1 as const;

export interface CoordinationManifestParentScope {
  readonly id: string;
  readonly issueNumber?: number;
  readonly title?: string;
}

export interface CoordinationManifestAcceptedTask {
  readonly id: string;
  readonly issueNumber?: number;
  readonly title?: string;
  readonly branch: string;
}

export interface CoordinationManifestPublication {
  readonly publisher: "sandcastle";
  readonly publishedAt: string;
  readonly mergeRecommendation: MergeRecommendation;
  readonly acceptedTaskCount: number;
}

export interface CoordinationManifest {
  readonly kind: typeof COORDINATION_MANIFEST_KIND;
  readonly version: typeof COORDINATION_MANIFEST_VERSION;
  readonly parentScope: CoordinationManifestParentScope;
  readonly coordinatorBranch: string;
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly acceptedTasks: readonly CoordinationManifestAcceptedTask[];
  readonly publication: CoordinationManifestPublication;
}

export interface RenderCoordinationManifestOptions {
  readonly parent: ParentEffort;
  readonly coordinatorBranch: string;
  readonly targetBranch: string;
  readonly baseBranch: string;
  readonly acceptedForIntegrationTasks: readonly Pick<
    AcceptedForIntegrationTask,
    "task" | "branch"
  >[];
  readonly mergeRecommendation: MergeRecommendation;
  readonly publishedAt: string;
}

const START_MARKER = "<!-- sandcastle:coordination-manifest:start -->";
const END_MARKER = "<!-- sandcastle:coordination-manifest:end -->";
const MANIFEST_PATTERN = new RegExp(
  `${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*\`\`\`json\\s*\\n([\\s\\S]*?)\\n\\s*\`\`\`\\s*\\n\\s*${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  "g",
);

const parseIssueNumber = (id: string): number | undefined => {
  const match = id.match(/^#?(\d+)$/) ?? id.match(/github-issue:(\d+)$/);
  const issueNumber = match?.[1] ? Number(match[1]) : undefined;
  return Number.isInteger(issueNumber) ? issueNumber : undefined;
};

const omitUndefined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;

const buildManifest = (
  options: RenderCoordinationManifestOptions,
): CoordinationManifest => ({
  kind: COORDINATION_MANIFEST_KIND,
  version: COORDINATION_MANIFEST_VERSION,
  parentScope: omitUndefined({
    id: options.parent.id,
    issueNumber: parseIssueNumber(options.parent.id),
    title: options.parent.title,
  }),
  coordinatorBranch: options.coordinatorBranch,
  targetBranch: options.targetBranch,
  baseBranch: options.baseBranch,
  acceptedTasks: options.acceptedForIntegrationTasks.map((task) =>
    omitUndefined({
      id: task.task.id,
      issueNumber: parseIssueNumber(task.task.id),
      title: task.task.title,
      branch: task.branch,
    }),
  ),
  publication: {
    publisher: "sandcastle",
    publishedAt: options.publishedAt,
    mergeRecommendation: options.mergeRecommendation,
    acceptedTaskCount: options.acceptedForIntegrationTasks.length,
  },
});

export const renderCoordinationManifest = (
  options: RenderCoordinationManifestOptions,
): string => {
  const manifest = buildManifest(options);
  return [
    START_MARKER,
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    END_MARKER,
  ].join("\n");
};

const VALID_MERGE_RECOMMENDATIONS = new Set<MergeRecommendation>([
  "recommend-merge",
  "do-not-recommend-merge-yet",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
  value: Record<string, unknown>,
  fieldName: string,
): string => {
  const fieldValue = value[fieldName];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(
      `Invalid Sandcastle coordination manifest: ${fieldName} is required.`,
    );
  }

  return fieldValue;
};

const optionalNumber = (
  value: Record<string, unknown>,
  fieldName: string,
): number | undefined => {
  const fieldValue = value[fieldName];
  if (fieldValue === undefined) {
    return undefined;
  }
  if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue)) {
    throw new Error(
      `Invalid Sandcastle coordination manifest: ${fieldName} must be an integer.`,
    );
  }
  return fieldValue;
};

const requireNumber = (
  value: Record<string, unknown>,
  fieldName: string,
  fieldLabel = fieldName,
): number => {
  const fieldValue = optionalNumber(value, fieldName);
  if (fieldValue === undefined) {
    throw new Error(
      `Invalid Sandcastle coordination manifest: ${fieldLabel} is required.`,
    );
  }

  return fieldValue;
};

const requirePublisher = (value: Record<string, unknown>): "sandcastle" => {
  const publisher = requireString(value, "publisher");
  if (publisher !== "sandcastle") {
    throw new Error(
      "Invalid Sandcastle coordination manifest: publication.publisher is invalid.",
    );
  }

  return "sandcastle";
};

const requireMergeRecommendation = (
  value: Record<string, unknown>,
): MergeRecommendation => {
  const mergeRecommendation = requireString(value, "mergeRecommendation");
  if (
    !VALID_MERGE_RECOMMENDATIONS.has(mergeRecommendation as MergeRecommendation)
  ) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: publication.mergeRecommendation is invalid.",
    );
  }

  return mergeRecommendation as MergeRecommendation;
};

export const parseCoordinationManifest = (
  manifestJson: string,
): CoordinationManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch (error) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: JSON could not be parsed.",
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: manifest must be an object.",
    );
  }
  if (parsed.kind !== COORDINATION_MANIFEST_KIND) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: kind is required.",
    );
  }
  if (parsed.version !== COORDINATION_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported Sandcastle coordination manifest version: ${String(parsed.version)}.`,
    );
  }

  const parentScope = parsed.parentScope;
  if (!isRecord(parentScope)) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: parentScope is required.",
    );
  }

  const acceptedTasks = parsed.acceptedTasks;
  if (!Array.isArray(acceptedTasks)) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: acceptedTasks is required.",
    );
  }

  const publication = parsed.publication;
  if (!isRecord(publication)) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: publication is required.",
    );
  }

  const parsedAcceptedTasks = acceptedTasks.map((acceptedTask, index) => {
    if (!isRecord(acceptedTask)) {
      throw new Error(
        `Invalid Sandcastle coordination manifest: acceptedTasks[${index}] must be an object.`,
      );
    }
    return omitUndefined({
      id: requireString(acceptedTask, "id"),
      issueNumber: optionalNumber(acceptedTask, "issueNumber"),
      title:
        typeof acceptedTask.title === "string" ? acceptedTask.title : undefined,
      branch: requireString(acceptedTask, "branch"),
    });
  });
  const acceptedTaskCount = requireNumber(
    publication,
    "acceptedTaskCount",
    "publication.acceptedTaskCount",
  );
  if (acceptedTaskCount !== parsedAcceptedTasks.length) {
    throw new Error(
      "Invalid Sandcastle coordination manifest: publication.acceptedTaskCount does not match acceptedTasks.",
    );
  }

  return {
    kind: COORDINATION_MANIFEST_KIND,
    version: COORDINATION_MANIFEST_VERSION,
    parentScope: omitUndefined({
      id: requireString(parentScope, "id"),
      issueNumber: optionalNumber(parentScope, "issueNumber"),
      title:
        typeof parentScope.title === "string" ? parentScope.title : undefined,
    }),
    coordinatorBranch: requireString(parsed, "coordinatorBranch"),
    targetBranch: requireString(parsed, "targetBranch"),
    baseBranch: requireString(parsed, "baseBranch"),
    acceptedTasks: parsedAcceptedTasks,
    publication: {
      publisher: requirePublisher(publication),
      publishedAt: requireString(publication, "publishedAt"),
      mergeRecommendation: requireMergeRecommendation(publication),
      acceptedTaskCount,
    },
  };
};

export const parseCoordinationManifestFromBody = (
  body: string,
): CoordinationManifest | undefined => {
  MANIFEST_PATTERN.lastIndex = 0;
  const match = MANIFEST_PATTERN.exec(body);
  if (!match?.[1]) {
    return undefined;
  }

  return parseCoordinationManifest(match[1]);
};

export const upsertCoordinationManifest = (
  body: string,
  options: RenderCoordinationManifestOptions,
): string => {
  const manifest = renderCoordinationManifest(options);
  const humanReport = body.replace(MANIFEST_PATTERN, "").trim();

  return humanReport ? `${humanReport}\n\n${manifest}` : manifest;
};
