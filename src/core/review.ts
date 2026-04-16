import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadMemoryFromMarkdown, loadProjectMemories, publishCandidateMarkdownToProject } from "./memory.js";
import { conflictsDir } from "./paths.js";
import { claimNextPending, completeClaim } from "./queue.js";
import type {
  BunshinConfig,
  MemoryEntry,
  QueueDecision,
  ReviewNextOptions,
  ReviewOutcome,
} from "./types.js";

function overlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }

  const set = new Set(a.map((item) => item.toLowerCase()));
  return b.some((item) => set.has(item.toLowerCase()));
}

function normalizeSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(input: string): string[] {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);

  return Array.from(new Set(tokens));
}

export function findRelatedProjectMemories(config: BunshinConfig, candidate: MemoryEntry): MemoryEntry[] {
  const all = loadProjectMemories(config, candidate.type);
  const summaryTokens = tokenize(candidate.summary);

  return all.filter((entry) => {
    if (entry.id === candidate.id) {
      return true;
    }

    if (overlap(candidate.tags, entry.tags)) {
      return true;
    }

    if (overlap(candidate.paths, entry.paths)) {
      return true;
    }

    if (summaryTokens.length === 0) {
      return false;
    }

    const haystack = `${entry.summary} ${entry.detail ?? ""} ${entry.takeaway ?? ""}`.toLowerCase();
    return summaryTokens.some((token) => haystack.includes(token));
  });
}

function writeConflictArtifact(
  config: BunshinConfig,
  queueId: string,
  candidate: MemoryEntry,
  related: MemoryEntry[],
  reason: string,
): string {
  const filePath = path.join(conflictsDir(config), `conflict_${queueId}.md`);
  mkdirSync(path.dirname(filePath), { recursive: true });

  const relatedBlocks =
    related.length === 0
      ? "(none)"
      : related
          .map((entry) => {
            return [
              `- ${entry.id} (${entry.type})`,
              `  - summary: ${entry.summary}`,
              `  - path: ${entry.absolutePath}`,
            ].join("\n");
          })
          .join("\n");

  const markdown = [
    `# Bunshin Conflict ${queueId}`,
    "",
    `- candidate_id: ${candidate.id}`,
    `- candidate_type: ${candidate.type}`,
    `- reason: ${reason}`,
    "",
    "## Candidate Summary",
    candidate.summary,
    "",
    "## Candidate Body",
    candidate.rawBody,
    "",
    "## Related Project Memories",
    relatedBlocks,
    "",
  ].join("\n");

  writeFileSync(filePath, markdown, "utf8");
  return filePath;
}

function autoDecision(candidate: MemoryEntry, related: MemoryEntry[]): QueueDecision {
  const duplicate = related.find(
    (entry) => normalizeSummary(entry.summary) === normalizeSummary(candidate.summary),
  );

  if (duplicate) {
    return {
      kind: "reject",
      reason: `Duplicate summary already exists in project memory (${duplicate.id}).`,
      relatedIds: [duplicate.id],
    };
  }

  if (related.length === 0) {
    return {
      kind: "publish",
      reason: "No related project memory found.",
      relatedIds: [],
    };
  }

  const overlapConflict = related.some(
    (entry) =>
      normalizeSummary(entry.summary) !== normalizeSummary(candidate.summary) &&
      (overlap(candidate.tags, entry.tags) || overlap(candidate.paths, entry.paths)),
  );

  if (overlapConflict) {
    return {
      kind: "escalate",
      reason: "Found related project memory with overlapping scope and different summary.",
      relatedIds: related.map((entry) => entry.id),
    };
  }

  return {
    kind: "publish",
    reason: "Related items found, but no obvious conflict.",
    relatedIds: related.map((entry) => entry.id),
  };
}

function manualDecision(options: ReviewNextOptions, related: MemoryEntry[]): QueueDecision | null {
  if (!options.decision) {
    return null;
  }

  if (options.decision === "publish") {
    return {
      kind: "publish",
      reason: options.reason ?? "Manual publish.",
      relatedIds: related.map((entry) => entry.id),
    };
  }

  if (options.decision === "reject") {
    return {
      kind: "reject",
      reason: options.reason ?? "Manual reject.",
      relatedIds: related.map((entry) => entry.id),
    };
  }

  return {
    kind: "escalate",
    reason: options.reason ?? "Manual escalate.",
    relatedIds: related.map((entry) => entry.id),
  };
}

export function reviewNext(config: BunshinConfig, options: ReviewNextOptions = {}): ReviewOutcome | null {
  const reviewer = options.reviewerName ?? config.reviewerName;
  const claimed = claimNextPending(config, reviewer);
  if (!claimed) {
    return null;
  }

  const candidate = loadMemoryFromMarkdown(claimed.item.candidate.markdown, `<queue:${claimed.item.id}>`);
  const related = findRelatedProjectMemories(config, candidate);

  const chosenDecision = manualDecision(options, related) ?? autoDecision(candidate, related);

  let publishedPath: string | undefined;
  let conflictPath: string | undefined;

  if (chosenDecision.kind === "publish") {
    const published = publishCandidateMarkdownToProject(config, claimed.item.candidate.markdown);
    publishedPath = published.absolutePath;
    chosenDecision.publishedPath = published.absolutePath;
  }

  if (chosenDecision.kind === "escalate") {
    const reason = chosenDecision.reason ?? "Escalated by reviewer.";
    conflictPath = writeConflictArtifact(config, claimed.item.id, candidate, related, reason);
    chosenDecision.conflictPath = conflictPath;
  }

  const done = completeClaim(config, claimed.claimedPath, claimed.item, chosenDecision);

  return {
    queueId: done.id,
    candidateId: candidate.id,
    decision: chosenDecision,
    relatedIds: chosenDecision.relatedIds ?? related.map((entry) => entry.id),
    publishedPath,
    conflictPath,
  };
}
