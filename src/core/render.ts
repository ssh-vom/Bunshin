import path from "node:path";
import type {
  MemoryEntry,
  ReviewOutcome,
  SearchResult,
  StatusSnapshot,
} from "./types.js";
import type { PeekResult } from "./review.js";

function renderMetaLine(label: string, value: string | undefined): string {
  return `${label}: ${value ?? "-"}`;
}

export function renderMemory(entry: MemoryEntry): string {
  return [
    renderMetaLine("id", entry.id),
    renderMetaLine("type", entry.type),
    renderMetaLine("agent", entry.agent),
    renderMetaLine("created_at", entry.createdAt),
    renderMetaLine("topic", entry.topic),
    renderMetaLine("repo", entry.repo),
    renderMetaLine("branch", entry.branch),
    renderMetaLine("commit", entry.commit),
    renderMetaLine("tags", entry.tags.join(", ") || "-"),
    renderMetaLine("paths", entry.paths.join(", ") || "-"),
    renderMetaLine("file", entry.absolutePath),
    "",
    entry.rawBody,
  ].join("\n");
}

export function renderSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No matching memories.";
  }

  return results
    .map((result, index) => {
      const rel = path.relative(process.cwd(), result.absolutePath);
      const fileLine = result.line ? `   file: ${rel}:${result.line}` : `   file: ${rel}`;
      const summaryLabel = result.line !== undefined ? "match" : "summary";

      if (result.source === "project") {
        return [
          `${index + 1}. [project] ${result.topicSlug ?? result.id}`,
          `   ${summaryLabel}: ${result.summary}`,
          fileLine,
          `   updated_at: ${result.updatedAt}`,
        ].join("\n");
      }

      return [
        `${index + 1}. [local] ${result.id}${result.type ? ` (${result.type})` : ""}`,
        `   ${summaryLabel}: ${result.summary}`,
        fileLine,
        `   updated_at: ${result.updatedAt}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function renderPeekResult(result: PeekResult): string {
  // Output JSON format for the pi-extension to parse
  const output = {
    queueId: result.queueId,
    candidate: {
      id: result.candidate.id,
      type: result.candidate.type,
      summary: result.candidate.summary,
      rawBody: result.candidate.rawBody,
      markdown: result.candidate.markdown,
      tags: result.candidate.tags,
      paths: result.candidate.paths,
      agent: result.candidate.agent,
      createdAt: result.candidate.createdAt,
    },
    topic: result.topic,
    existingTopicContent: result.existingTopicContent,
  };
  return JSON.stringify(output, null, 2);
}

export function renderReviewOutcome(outcome: ReviewOutcome | null): string {
  if (!outcome) {
    return "No pending queue items.";
  }

  const lines = [
    `queue: ${outcome.queueId}`,
    `candidate: ${outcome.candidateId}`,
    `topic: ${outcome.topic}`,
    `topic_file: ${outcome.topicPath}`,
    `decision: ${outcome.decision.kind}`,
    `reason: ${outcome.decision.reason ?? "-"}`,
  ];

  if (outcome.publishedPath) {
    lines.push(`published: ${outcome.publishedPath}`);
  }

  if (outcome.conflictPath) {
    lines.push(`conflict: ${outcome.conflictPath}`);
  }

  return lines.join("\n");
}

export function renderStatus(snapshot: StatusSnapshot): string {
  const lines = [
    `pending: ${snapshot.pending}`,
    `claimed: ${snapshot.claimed}`,
    `done: ${snapshot.done}`,
    `conflicts: ${snapshot.conflicts}`,
    `topics: ${snapshot.projectTopics}`,
  ];

  if (snapshot.recentTopics.length > 0) {
    lines.push("", "recent topics:");
    for (const topic of snapshot.recentTopics) {
      lines.push(`- ${topic.slug}  ${topic.updatedAt}`);
    }
  }

  if (snapshot.recentDone.length > 0) {
    lines.push("", "recent done:");
    for (const item of snapshot.recentDone) {
      lines.push(
        `- ${item.id} (${item.decision?.kind ?? "unknown"}) candidate=${item.candidate.id}`,
      );
    }
  }

  return lines.join("\n");
}
