import test from "node:test";
import assert from "node:assert/strict";
import { createLocalMemory } from "../src/core/memory.js";
import { ensureInitializedDirs } from "../src/core/paths.js";
import { claimNextPending, completeClaim, enqueueLocalMemory, listQueueItems } from "../src/core/queue.js";
import { makeTestConfig } from "./helpers.js";

test("queue enqueue -> claim -> done", () => {
  const { config, cleanup } = makeTestConfig("queue");

  try {
    ensureInitializedDirs(config);

    const memory = createLocalMemory(config, {
      type: "worked",
      summary: "Fix migration by creating table before index",
      takeaway: "Order of schema operations matters",
      topic: "Migrations",
    });

    const queued = enqueueLocalMemory(config, memory);
    assert.equal(queued.status, "pending");
    assert.equal(queued.candidate.topic, "Migrations");

    const claimed = claimNextPending(config, "reviewer-a");
    assert.ok(claimed);
    assert.equal(claimed.item.status, "claimed");

    const done = completeClaim(config, claimed.claimedPath, claimed.item, {
      kind: "reject",
      reason: "Duplicate memory",
    });

    assert.equal(done.status, "done");
    assert.equal(done.decision?.kind, "reject");

    const doneItems = listQueueItems(config, "done");
    assert.equal(doneItems.length, 1);
    assert.equal(doneItems[0]?.id, queued.id);
  } finally {
    cleanup();
  }
});

test("queue rejects duplicate active candidate", () => {
  const { config, cleanup } = makeTestConfig("queue-duplicate");

  try {
    ensureInitializedDirs(config);

    const memory = createLocalMemory(config, {
      type: "fact",
      summary: "Cache lockfile hash rule",
    });

    enqueueLocalMemory(config, memory);

    assert.throws(
      () => enqueueLocalMemory(config, memory),
      /already queued/,
    );
  } finally {
    cleanup();
  }
});
