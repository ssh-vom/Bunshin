import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { getConfigOverrides } from "../context.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize local and shared Bunshin directories")
    .action(function action(this: Command) {
      const config = loadConfig(getConfigOverrides(this));

      ensureInitializedDirs(config);

      console.log(`initialized local root:  ${config.localRoot}`);
      console.log(`initialized shared root: ${config.sharedRoot}`);
    });
}
