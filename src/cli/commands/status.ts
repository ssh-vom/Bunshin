import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { ensureInitializedDirs } from "../../core/paths.js";
import { renderStatus } from "../../core/render.js";
import { getStatus } from "../../core/status.js";
import { getConfigOverrides } from "../context.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show queue and conflict status")
    .option("--json", "Output as JSON (for programmatic use)")
    .action(function action(
      this: Command,
      options: {
        json?: boolean;
      },
    ) {
      const config = loadConfig(getConfigOverrides(this));
      ensureInitializedDirs(config);
      const snapshot = getStatus(config);
      
      if (options.json) {
        console.log(JSON.stringify({
          ...snapshot,
          sharedRoot: config.sharedRoot,
          localRoot: config.localRoot,
        }, null, 2));
      } else {
        console.log(renderStatus(snapshot));
      }
    });
}
