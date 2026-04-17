import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { renderReviewOutcome, renderPeekResult } from "../../core/render.js";
import { reviewNext, peekNext } from "../../core/review.js";
import type { DecisionKind } from "../../core/types.js";
import { getConfigOverrides } from "../context.js";

function normalizeDecision(value?: string): DecisionKind | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "publish" || value === "reject" || value === "escalate") {
    return value;
  }

  throw new Error("--decision must be one of: publish | reject | escalate");
}

function runReview(
  command: Command,
  options: { decision?: string; reason?: string; reviewer?: string; peek?: boolean; queueId?: string },
): void {
  const config = loadConfig(getConfigOverrides(command));
  ensureInitializedDirs(config);

  // Peek mode: claim and return data without completing
  if (options.peek) {
    const peekResult = peekNext(config, {
      reviewerName: options.reviewer,
    });
    
    if (!peekResult) {
      console.log("No pending queue items.");
      return;
    }
    
    console.log(renderPeekResult(peekResult));
    return;
  }

  // Normal review mode: claim and complete
  const outcome = reviewNext(config, {
    reviewerName: options.reviewer,
    queueId: options.queueId,
    decision: normalizeDecision(options.decision),
    reason: options.reason,
  });

  console.log(renderReviewOutcome(outcome));
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Claim and process the next pending queue item")
    .option("--decision <decision>", "publish | reject | escalate")
    .option("--reason <reason>", "Optional reason")
    .option("--reviewer <name>", "Reviewer identity override")
    .option("--queue-id <id>", "Complete a previously claimed queue item by ID")
    .option("--peek", "Claim and return item data without completing (for LLM analysis)")
    .action(function action(
      this: Command,
      options: {
        decision?: string;
        reason?: string;
        reviewer?: string;
        peek?: boolean;
        queueId?: string;
      },
    ) {
      runReview(this, options);
    });
}
