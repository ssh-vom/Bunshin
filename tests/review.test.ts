import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLocalMemory } from "../src/core/memory.js";
import { ensureInitializedDirs, projectTopicPath } from "../src/core/paths.js";
import { enqueueLocalMemory, listQueueItems } from "../src/core/queue.js";
import { peekNext, reviewNext } from "../src/core/review.js";
import { makeTestConfig } from "./helpers.js";

function readTopicCount(topicPath: string): number {
  const markdown = readFileSync(topicPath, "utf8");
  const match = markdown.match(/review_count_since_compaction:\s*(\d+)/);
  return Number.parseInt(match?.[1] ?? "0", 10);
}

test("review appends to a new topic file with frontmatter count initialized to 1", () => {
  const { config, cleanup } = makeTestConfig("review-new-topic");

  try {
    ensureInitializedDirs(config);

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Cache key should include lockfile hash",
      topic: "CI Cache",
      tags: ["ci", "cache"],
      paths: [".github/workflows/ci.yml"],
    });

    enqueueLocalMemory(config, memory);
    const outcome = reviewNext(config);

    assert.ok(outcome);
    assert.equal(outcome.decision.kind, "publish");
    assert.equal(outcome.reviewCountSinceCompaction, 1);
    assert.equal(outcome.shouldCompact, false);

    const topicPath = projectTopicPath(config, "ci-cache");
    assert.ok(existsSync(topicPath), "topic file should exist");

    const body = readFileSync(topicPath, "utf8");
    assert.match(body, /^---\nreview_count_since_compaction:\s*1\n---/);
    assert.match(body, /# Topic: CI Cache/);
    assert.match(body, /## Working\n[\s\S]*## Long-term/);
    assert.match(body, /## History/);

    // fact → long-term
    const longTerm = body.split("## Long-term")[1]?.split("## History")[0] ?? "";
    assert.match(longTerm, /Cache key should include lockfile hash/);
    assert.match(longTerm, /kind=fact/);
    assert.match(longTerm, new RegExp(`source_memory=${memory.id}`));
  } finally {
    cleanup();
  }
});

test("repeated publishes increment compaction count and trigger shouldCompact at 3", () => {
  const { config, cleanup } = makeTestConfig("review-append");

  try {
    ensureInitializedDirs(config);

    const summaries = [
      "Cache key should include lockfile hash",
      "Cache key should include Node major version",
      "Cache key should include package manager version",
    ];

    const outcomes = summaries.map((summary) => {
      const memory = createLocalMemory(config, {
        type: "fact",
        summary,
        topic: "CI Cache",
      });
      enqueueLocalMemory(config, memory);
      const outcome = reviewNext(config);
      assert.ok(outcome);
      return outcome;
    });

    assert.equal(outcomes[0]?.reviewCountSinceCompaction, 1);
    assert.equal(outcomes[0]?.shouldCompact, false);

    assert.equal(outcomes[1]?.reviewCountSinceCompaction, 2);
    assert.equal(outcomes[1]?.shouldCompact, false);

    assert.equal(outcomes[2]?.reviewCountSinceCompaction, 3);
    assert.equal(outcomes[2]?.shouldCompact, true);

    const topicPath = projectTopicPath(config, "ci-cache");
    assert.equal(readTopicCount(topicPath), 3);
  } finally {
    cleanup();
  }
});

test("review with --decision reject marks the item done without touching topic files", () => {
  const { config, cleanup } = makeTestConfig("review-reject");

  try {
    ensureInitializedDirs(config);

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Temporary guidance",
      topic: "Ephemeral",
    });
    enqueueLocalMemory(config, memory);

    const outcome = reviewNext(config, { decision: "reject", reason: "Not project-wide" });

    assert.ok(outcome);
    assert.equal(outcome.decision.kind, "reject");
    assert.equal(outcome.reviewCountSinceCompaction, 0);
    assert.equal(outcome.shouldCompact, false);
    assert.ok(!existsSync(projectTopicPath(config, "ephemeral")));

    const done = listQueueItems(config, "done");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.decision?.kind, "reject");
  } finally {
    cleanup();
  }
});

test("peekNext claims an item and reviewNext can complete that claim by queueId", () => {
  const { config, cleanup } = makeTestConfig("review-peek-complete");

  try {
    ensureInitializedDirs(config);

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Cache key should include lockfile hash",
      topic: "CI Cache",
    });
    enqueueLocalMemory(config, memory);

    const peeked = peekNext(config, { reviewerName: "reviewer-1" });
    assert.ok(peeked);
    assert.equal(peeked.queueId.length > 0, true);

    const outcome = reviewNext(config, {
      queueId: peeked.queueId,
      decision: "publish",
      reason: "New stable guidance",
    });

    assert.ok(outcome);
    assert.equal(outcome.queueId, peeked.queueId);
    assert.equal(outcome.decision.kind, "publish");
    assert.equal(outcome.reviewCountSinceCompaction, 1);
    assert.equal(outcome.shouldCompact, false);

    const topicPath = projectTopicPath(config, "ci-cache");
    const body = readFileSync(topicPath, "utf8");
    assert.match(body, /Cache key should include lockfile hash/);
    assert.equal(readTopicCount(topicPath), 1);

    const claimed = listQueueItems(config, "claimed");
    const done = listQueueItems(config, "done");
    assert.equal(claimed.length, 0);
    assert.equal(done.length, 1);
    assert.equal(done[0]?.id, peeked.queueId);
  } finally {
    cleanup();
  }
});

test("review with --decision escalate writes a conflict artifact and leaves topic count unchanged", () => {
  const { config, cleanup } = makeTestConfig("review-escalate");

  try {
    ensureInitializedDirs(config);

    const base = createLocalMemory(config, {
      type: "fact",
      summary: "Use pnpm with lockfile for deterministic installs",
      topic: "Package Manager",
    });
    enqueueLocalMemory(config, base);
    const firstOutcome = reviewNext(config);
    assert.ok(firstOutcome);
    assert.equal(firstOutcome.reviewCountSinceCompaction, 1);

    const topicPath = projectTopicPath(config, "package-manager");
    assert.equal(readTopicCount(topicPath), 1);

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Ambiguous package manager guidance",
      topic: "Package Manager",
    });
    enqueueLocalMemory(config, memory);

    const outcome = reviewNext(config, { decision: "escalate", reason: "Needs human judgment" });

    assert.ok(outcome);
    assert.equal(outcome.decision.kind, "escalate");
    assert.equal(outcome.reviewCountSinceCompaction, 0);
    assert.equal(outcome.shouldCompact, false);
    assert.ok(outcome.conflictPath);
    assert.ok(existsSync(outcome.conflictPath!));

    const conflict = readFileSync(outcome.conflictPath!, "utf8");
    assert.match(conflict, /Needs human judgment/);
    assert.match(conflict, new RegExp(`candidate_id: ${memory.id}`));

    assert.equal(readTopicCount(topicPath), 1);
  } finally {
    cleanup();
  }
});

test("existing topic file without frontmatter is treated as count 0 and upgraded on publish", () => {
  const { config, cleanup } = makeTestConfig("review-legacy-topic");

  try {
    ensureInitializedDirs(config);

    const topicPath = projectTopicPath(config, "legacy-topic");
    writeFileSync(
      topicPath,
      [
        "# Topic: Legacy Topic",
        "",
        "## Working",
        "- (none)",
        "",
        "## Long-term",
        "- existing knowledge",
        "",
        "## History",
        "- (none)",
        "",
      ].join("\n"),
      "utf8",
    );

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Fresh publish against old-style topic",
      topic: "Legacy Topic",
    });
    enqueueLocalMemory(config, memory);

    const outcome = reviewNext(config);

    assert.ok(outcome);
    assert.equal(outcome.decision.kind, "publish");
    assert.equal(outcome.reviewCountSinceCompaction, 1);
    assert.equal(outcome.shouldCompact, false);

    const body = readFileSync(topicPath, "utf8");
    assert.match(body, /^---\nreview_count_since_compaction:\s*1\n---/);
    assert.match(body, /Fresh publish against old-style topic/);
  } finally {
    cleanup();
  }
});
