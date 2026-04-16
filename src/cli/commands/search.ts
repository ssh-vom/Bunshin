import { Command } from "commander";
import { loadConfig } from "../../core/config.js";
import { renderSearchResults } from "../../core/render.js";
import { searchMemories } from "../../core/search.js";
import { MEMORY_TYPES, type MemoryType } from "../../core/types.js";
import { getConfigOverrides } from "../context.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Search project memory (and optionally local memory)")
    .argument("[query]", "Query string (omit to list recent memories)")
    .option("--include-local", "Include local memories", false)
    .option("--type <type>", "Filter by type")
    .option("--tag <tag>", "Filter by tag")
    .option("--path <path>", "Filter by project path substring")
    .option("--limit <n>", "Result limit", "20")
    .action(function action(
      this: Command,
      query: string | undefined,
      options: {
        includeLocal?: boolean;
        type?: string;
        tag?: string;
        path?: string;
        limit?: string;
      },
    ) {
      const config = loadConfig(getConfigOverrides(this));

      let typeFilter: MemoryType | undefined;
      if (options.type) {
        if (!MEMORY_TYPES.includes(options.type as MemoryType)) {
          throw new Error(`Invalid --type: ${options.type}. Use one of ${MEMORY_TYPES.join(", ")}`);
        }
        typeFilter = options.type as MemoryType;
      }

      const limit = Number.parseInt(options.limit ?? "20", 10);
      const results = searchMemories(config, query ?? "", {
        includeLocal: options.includeLocal,
        type: typeFilter,
        tag: options.tag,
        path: options.path,
        limit: Number.isFinite(limit) ? limit : 20,
      });

      console.log(renderSearchResults(results));
    });
}
