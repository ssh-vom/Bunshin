import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { renderReviewOutcome } from "../../core/render.js";
import { reviewNext } from "../../core/review.js";
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

export function registerReviewCommand(program: Command): void {
  const review = program.command("review").description("Review queue operations");

  review
    .command("next")
    .description("Claim and process the next pending queue item")
    .option("--decision <decision>", "publish | reject | escalate")
    .option("--reason <reason>", "Optional reason")
    .option("--reviewer <name>", "Reviewer identity override")
    .action(function action(
      this: Command,
      options: {
        decision?: string;
        reason?: string;
        reviewer?: string;
      },
    ) {
      const config = loadConfig(getConfigOverrides(this));
      ensureInitializedDirs(config);

      const outcome = reviewNext(config, {
        reviewerName: options.reviewer,
        decision: normalizeDecision(options.decision),
        reason: options.reason,
      });

      console.log(renderReviewOutcome(outcome));
    });
}
