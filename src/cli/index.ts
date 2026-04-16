#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerShowCommand } from "./commands/show.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWriteCommand } from "./commands/write.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("bunshin")
    .description("Local-first filesystem memory for parallel coding agents")
    .option("--local-root <path>", "Override local root")
    .option("--shared-root <path>", "Override shared root")
    .option("--agent <name>", "Override agent name")
    .option("--reviewer <name>", "Override reviewer name")
    .option("--repo-name <name>", "Override repo name")
    .showHelpAfterError(true);

  registerInitCommand(program);
  registerWriteCommand(program);
  registerShowCommand(program);
  registerSearchCommand(program);
  registerPublishCommand(program);
  registerReviewCommand(program);
  registerStatusCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`bunshin error: ${error.message}`);
  } else {
    console.error("bunshin error:", error);
  }
  process.exit(1);
});
