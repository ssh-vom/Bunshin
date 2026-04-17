import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendBulletToTopic,
  loadMemoryFromMarkdown,
  readTopicReviewCount,
  sectionForType,
  topicBulletFromMemory,
  writeTopicReviewCount,
} from "./memory.js";
import { conflictsDir, projectTopicPath, topicSlug } from "./paths.js";
import { claimNextPending, completeClaim, getClaimedItem } from "./queue.js";
import type {
  BunshinConfig,
  MemoryEntry,
  QueueDecision,
  ReviewNextOptions,
  ReviewOutcome,
} from "./types.js";

const GENERIC_PATH_BASENAMES = new Set(["index", "main", "readme"]);
const COMPACTION_REVIEW_THRESHOLD = 3;

function topicFromPath(inputPath: string): string | null {
  const normalized = inputPath.replace(/\\/g, "/").trim();
  if (!normalized) {
    return null;
  }

  const basename = path.posix.basename(normalized, path.posix.extname(normalized));
  if (!basename) {
    return null;
  }

  if (GENERIC_PATH_BASENAMES.has(basename.toLowerCase())) {
    const parent = path.posix.basename(path.posix.dirname(normalized));
    if (parent && parent !== "." && parent !== "/") {
      return parent;
    }
    return null;
  }

  return basename;
}

function resolveTopic(candidate: MemoryEntry): { title: string; slug: string } {
  if (candidate.topic?.trim()) {
    const title = candidate.topic.trim();
    return { title, slug: topicSlug(title) };
  }

  for (const entry of candidate.paths) {
    const derived = topicFromPath(entry);
    if (derived) {
      return { title: derived, slug: topicSlug(derived) };
    }
  }

  if (candidate.tags.length > 0) {
    const title = candidate.tags[0]!;
    return { title, slug: topicSlug(title) };
  }

  return { title: "General", slug: "general" };
}

function writeConflictArtifact(
  config: BunshinConfig,
  queueId: string,
  candidate: MemoryEntry,
  topic: { title: string; slug: string },
  reason: string,
): string {
  const filePath = path.join(conflictsDir(config), `conflict_${queueId}.md`);
  mkdirSync(path.dirname(filePath), { recursive: true });

  const markdown = [
    `# Bunshin Conflict ${queueId}`,
    "",
    `- candidate_id: ${candidate.id}`,
    `- candidate_type: ${candidate.type}`,
    `- resolved_topic: ${topic.title} (${topic.slug})`,
    `- reason: ${reason}`,
    "",
    "## Candidate Summary",
    candidate.summary,
    "",
    "## Candidate Body",
    candidate.rawBody,
    "",
  ].join("\n");

  writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

export interface PeekResult {
  queueId: string;
  claimedPath: string;
  candidate: MemoryEntry;
  topic: { title: string; slug: string };
  existingTopicContent: string | null;
}

/**
 * Claim the next pending item and return its data without completing the review.
 * Used by the pi-extension for LLM-powered intelligent review.
 */
export function peekNext(config: BunshinConfig, options: { reviewerName?: string } = {}): PeekResult | null {
  const reviewer = options.reviewerName ?? config.reviewerName;
  const claimed = claimNextPending(config, reviewer);
  if (!claimed) {
    return null;
  }

  const candidate = loadMemoryFromMarkdown(
    claimed.item.candidate.markdown,
    `<queue:${claimed.item.id}>`,
  );
  const resolved = resolveTopic(candidate);
  const topicPath = projectTopicPath(config, resolved.slug);

  // Load existing topic content if available
  let existingTopicContent: string | null = null;
  if (existsSync(topicPath)) {
    try {
      existingTopicContent = readFileSync(topicPath, "utf8");
    } catch {
      existingTopicContent = null;
    }
  }

  return {
    queueId: claimed.item.id,
    claimedPath: claimed.claimedPath,
    candidate,
    topic: resolved,
    existingTopicContent,
  };
}

export function reviewNext(config: BunshinConfig, options: ReviewNextOptions = {}): ReviewOutcome | null {
  const reviewer = options.reviewerName ?? config.reviewerName;
  const claimed = options.queueId
    ? getClaimedItem(config, options.queueId)
    : claimNextPending(config, reviewer);
  if (!claimed) {
    return null;
  }

  const candidate = loadMemoryFromMarkdown(
    claimed.item.candidate.markdown,
    `<queue:${claimed.item.id}>`,
  );
  const resolved = resolveTopic(candidate);
  const topicPath = projectTopicPath(config, resolved.slug);

  let decision: QueueDecision;
  let publishedPath: string | undefined;
  let conflictPath: string | undefined;
  let reviewCountSinceCompaction = 0;
  let shouldCompact = false;

  if (options.decision === "reject") {
    decision = {
      kind: "reject",
      reason: options.reason ?? "Manual reject.",
      topic: resolved.title,
      topicPath,
    };
  } else if (options.decision === "escalate") {
    const reason = options.reason ?? "Manual escalate.";
    conflictPath = writeConflictArtifact(config, claimed.item.id, candidate, resolved, reason);
    decision = {
      kind: "escalate",
      reason,
      topic: resolved.title,
      topicPath,
      conflictPath,
    };
  } else {
    const bullet = topicBulletFromMemory(candidate);
    const section = sectionForType(candidate.type);
    const { absolutePath } = appendBulletToTopic(config, resolved.slug, bullet, section);

    const markdown = readFileSync(absolutePath, "utf8");
    const currentCount = readTopicReviewCount(markdown);
    const nextCount = currentCount + 1;
    writeFileSync(absolutePath, writeTopicReviewCount(markdown, nextCount), "utf8");

    reviewCountSinceCompaction = nextCount;
    shouldCompact = nextCount >= COMPACTION_REVIEW_THRESHOLD;

    publishedPath = absolutePath;
    decision = {
      kind: "publish",
      reason: `Appended to ${resolved.title} (${section}).`,
      topic: resolved.title,
      topicPath: absolutePath,
      publishedPath: absolutePath,
    };
  }

  const done = completeClaim(config, claimed.claimedPath, claimed.item, decision);

  return {
    queueId: done.id,
    candidateId: candidate.id,
    decision,
    topic: resolved.title,
    topicPath: decision.topicPath ?? topicPath,
    publishedPath,
    conflictPath,
    reviewCountSinceCompaction,
    shouldCompact,
  };
}
