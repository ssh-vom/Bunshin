import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { renderStatus } from "../../core/render.js";
import { getStatus } from "../../core/status.js";
import { getConfigOverrides } from "../context.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show queue and conflict status")
    .action(function action(this: Command) {
      const config = loadConfig(getConfigOverrides(this));
      const snapshot = getStatus(config);
      console.log(renderStatus(snapshot));
    });
}
