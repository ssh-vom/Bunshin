#!/usr/bin/env node
import { Command } from "commander";
import { registerFindCommand } from "./commands/find.js";
import { registerInitCommand } from "./commands/init.js";
import { registerNoteCommand } from "./commands/note.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerShowCommand } from "./commands/show.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSubmitCommand } from "./commands/submit.js";

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
  registerNoteCommand(program);
  registerSubmitCommand(program);
  registerReviewCommand(program);
  registerFindCommand(program);
  registerStatusCommand(program);
  registerShowCommand(program);

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
