import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, toMarkdownWithFrontmatter } from "./frontmatter.js";
import {
  archiveProjectMemory,
  loadMemoryFromMarkdown,
  loadProjectMemories,
  publishCandidateMarkdownToProject,
} from "./memory.js";
import { conflictsDir } from "./paths.js";
import { claimNextPending, completeClaim } from "./queue.js";
import type {
  BunshinConfig,
  MemoryEntry,
  QueueDecision,
  ReviewNextOptions,
  ReviewOutcome,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function overlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }

  const set = new Set(a.map((item) => item.toLowerCase()));
  return b.some((item) => set.has(item.toLowerCase()));
}

function overlapCount(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const set = new Set(a.map((item) => item.toLowerCase()));
  return b.reduce((count, item) => (set.has(item.toLowerCase()) ? count + 1 : count), 0);
}

function normalizeSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(input: string, minimumLength = 4): string[] {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= minimumLength);

  return Array.from(new Set(tokens));
}

function normalizeList(values: Array<string | undefined>): string[] {
  return values.map((value) => value?.trim() ?? "").filter((value): value is string => value.length > 0);
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(value);
  }

  return out;
}

function extractUseTarget(summary: string): string | undefined {
  const match = summary.toLowerCase().match(/\buse\s+([a-z0-9][a-z0-9._-]*)\b/);
  return match?.[1];
}

function hasNegation(summary: string): boolean {
  const normalized = summary.toLowerCase();
  return /(\bdo not\b|\bdon't\b|\bmust not\b|\bnever\b|\bavoid\b|\bdisable\b)/.test(normalized);
}

function isLikelyContradictory(aSummary: string, bSummary: string): boolean {
  const a = normalizeSummary(aSummary);
  const b = normalizeSummary(bSummary);

  if (a === b) {
    return false;
  }

  const useA = extractUseTarget(a);
  const useB = extractUseTarget(b);
  if (useA && useB && useA !== useB) {
    return true;
  }

  const aHasEnable = a.includes(" enable ") || a.startsWith("enable ");
  const bHasEnable = b.includes(" enable ") || b.startsWith("enable ");
  const aHasDisable = a.includes(" disable ") || a.startsWith("disable ");
  const bHasDisable = b.includes(" disable ") || b.startsWith("disable ");

  if ((aHasEnable && bHasDisable) || (aHasDisable && bHasEnable)) {
    const tokenOverlap = overlapCount(tokenize(a, 3), tokenize(b, 3));
    if (tokenOverlap >= 1) {
      return true;
    }
  }

  const aNeg = hasNegation(a);
  const bNeg = hasNegation(b);
  if (aNeg !== bNeg) {
    const tokenOverlap = overlapCount(tokenize(a, 3), tokenize(b, 3));
    if (tokenOverlap >= 2) {
      return true;
    }
  }

  return false;
}

function relationScore(candidate: MemoryEntry, entry: MemoryEntry): number {
  let score = 0;

  if (overlap(candidate.tags, entry.tags)) {
    score += 2;
  }

  if (overlap(candidate.paths, entry.paths)) {
    score += 2;
  }

  const summaryOverlap = overlapCount(tokenize(candidate.summary, 4), tokenize(entry.summary, 4));
  if (summaryOverlap >= 3) {
    score += 2;
  } else if (summaryOverlap >= 2) {
    score += 1;
  }

  return score;
}

function pickConsolidationTargets(candidate: MemoryEntry, related: MemoryEntry[]): MemoryEntry[] {
  return related.filter((entry) => entry.id !== candidate.id && relationScore(candidate, entry) >= 2);
}

function buildBody(summary: string, detail?: string, takeaway?: string): string {
  const chunks: string[] = [`## Summary\n${summary.trim()}`];

  if (detail?.trim()) {
    chunks.push(`## Detail\n${detail.trim()}`);
  }

  if (takeaway?.trim()) {
    chunks.push(`## Takeaway\n${takeaway.trim()}`);
  }

  return chunks.join("\n\n");
}

function buildConsolidatedCandidateMarkdown(
  candidateMarkdown: string,
  candidate: MemoryEntry,
  consolidationTargets: MemoryEntry[],
): string {
  if (consolidationTargets.length === 0) {
    return candidateMarkdown;
  }

  const { frontmatter } = parseFrontmatter(candidateMarkdown);
  if (!isRecord(frontmatter)) {
    return candidateMarkdown;
  }

  const mergedTags = uniqueCaseInsensitive([
    ...candidate.tags,
    ...consolidationTargets.flatMap((entry) => entry.tags),
  ]);
  const mergedPaths = uniqueCaseInsensitive([
    ...candidate.paths,
    ...consolidationTargets.flatMap((entry) => entry.paths),
  ]);

  if (mergedTags.length > 0) {
    frontmatter.tags = mergedTags;
  }

  if (mergedPaths.length > 0) {
    frontmatter.paths = mergedPaths;
  }

  if (typeof frontmatter.supersedes !== "string" || !frontmatter.supersedes.trim()) {
    frontmatter.supersedes = consolidationTargets[0]?.id;
  }

  frontmatter.consolidated_from = consolidationTargets.map((entry) => entry.id);

  const detailParts = normalizeList([
    candidate.detail,
    consolidationTargets.length > 0
      ? [
          "Consolidated context from prior project memories:",
          ...consolidationTargets.map((entry) => {
            const takeaway = entry.takeaway?.trim();
            if (!takeaway) {
              return `- (${entry.id}) ${entry.summary}`;
            }
            return `- (${entry.id}) ${entry.summary} — ${takeaway}`;
          }),
        ].join("\n")
      : undefined,
  ]);

  const takeaways = uniqueCaseInsensitive(
    normalizeList([candidate.takeaway, ...consolidationTargets.map((entry) => entry.takeaway)]),
  );

  const takeawayBody =
    takeaways.length === 0
      ? undefined
      : takeaways.length === 1
        ? takeaways[0]
        : takeaways.map((item) => `- ${item}`).join("\n");

  const body = buildBody(candidate.summary, detailParts.join("\n\n") || undefined, takeawayBody);
  return toMarkdownWithFrontmatter(frontmatter, body);
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

  const conflicting = related.filter((entry) => isLikelyContradictory(candidate.summary, entry.summary));
  if (conflicting.length > 0) {
    const ids = conflicting.map((entry) => entry.id);
    return {
      kind: "escalate",
      reason: `Likely contradiction with existing project memory (${ids.join(", ")}).`,
      relatedIds: ids,
    };
  }

  const consolidationTargets = pickConsolidationTargets(candidate, related);
  if (consolidationTargets.length > 0) {
    return {
      kind: "publish",
      reason: `Consolidating with ${consolidationTargets.length} related project memories.`,
      relatedIds: consolidationTargets.map((entry) => entry.id),
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

  const manual = manualDecision(options, related);
  const chosenDecision = manual ?? autoDecision(candidate, related);

  let publishedPath: string | undefined;
  let conflictPath: string | undefined;

  if (chosenDecision.kind === "publish") {
    const consolidationTargets = manual ? [] : pickConsolidationTargets(candidate, related);

    const markdownToPublish = buildConsolidatedCandidateMarkdown(
      claimed.item.candidate.markdown,
      candidate,
      consolidationTargets,
    );

    const published = publishCandidateMarkdownToProject(config, markdownToPublish);
    publishedPath = published.absolutePath;
    chosenDecision.publishedPath = published.absolutePath;

    if (consolidationTargets.length > 0) {
      const archivedPaths = consolidationTargets.map((entry) => archiveProjectMemory(config, entry));
      chosenDecision.archivedRelatedPaths = archivedPaths;
      chosenDecision.relatedIds = consolidationTargets.map((entry) => entry.id);

      if (!chosenDecision.reason?.includes("Consolidating")) {
        chosenDecision.reason = `Consolidated with ${consolidationTargets.length} related project memories.`;
      }
    }
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
