import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

interface BunshinCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  runner: string;
}

function runBunshin(cwd: string, args: string[]): BunshinCommandResult {
  const distCli = path.join(cwd, "dist", "cli", "index.js");

  const runners: Array<{ command: string; prefixArgs: string[]; enabled: boolean; label: string }> = [
    { command: "bunshin", prefixArgs: [], enabled: true, label: "bunshin" },
    { command: "node", prefixArgs: [distCli], enabled: existsSync(distCli), label: `node ${distCli}` },
  ];

  let lastError: Error | undefined;

  for (const runner of runners) {
    if (!runner.enabled) {
      continue;
    }

    const result = spawnSync(runner.command, [...runner.prefixArgs, ...args], {
      cwd,
      env: process.env,
      encoding: "utf8",
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        lastError = result.error;
        continue;
      }

      throw result.error;
    }

    return {
      ok: (result.status ?? 1) === 0,
      exitCode: result.status ?? 1,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      runner: runner.label,
    };
  }

  throw new Error(
    [
      "Could not find a Bunshin executable.",
      "Tried: bunshin and node dist/cli/index.js",
      "Build Bunshin first with: npm run build",
      lastError ? `Last error: ${lastError.message}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toSearchQuery(prompt: string): string {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

function toAutoSummary(prompt: string): string {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) {
    return "Auto memory from Pi agent run";
  }

  return truncate(`Task insight: ${normalized}`, 140);
}

function parseMemoryId(output: string): string | undefined {
  const match = output.match(/wrote memory\s+(mem_[a-z0-9]+)/i);
  return match?.[1];
}

function parseStatusCount(output: string, key: "pending" | "claimed" | "done" | "conflicts"): number | undefined {
  const match = output.match(new RegExp(`(?:^|\\n)${key}:\\s*(\\d+)`, "i"));
  if (!match || !match[1]) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value)) {
    return undefined;
  }

  return value;
}

function isMemoryType(value: string | undefined): value is "worked" | "failed" | "fact" {
  return value === "worked" || value === "failed" || value === "fact";
}

function isReviewerAgent(): boolean {
  const agentName = process.env.BUNSHIN_AGENT_NAME?.trim();
  const reviewerName = process.env.BUNSHIN_REVIEWER_NAME?.trim();
  if (!agentName || !reviewerName) {
    return false;
  }

  return agentName === reviewerName;
}

function reviewerQueueWatchEnabled(): boolean {
  const configured = process.env.BUNSHIN_REVIEWER_WATCH_QUEUE;
  if (configured === "1") {
    return true;
  }

  if (configured === "0") {
    return false;
  }

  return isReviewerAgent();
}

function reviewerPollIntervalMs(): number {
  const parsed = Number.parseInt(process.env.BUNSHIN_REVIEWER_POLL_MS ?? "", 10);
  if (Number.isNaN(parsed)) {
    return 4000;
  }

  return Math.min(Math.max(parsed, 1000), 60000);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function post(pi: any, content: string): void {
  pi.sendMessage({
    customType: "bunshin",
    content,
    display: true,
  });
}

export default function bunshinExtension(pi: any) {
  let currentPrompt: string | null = null;
  let lastWrittenMemoryId: string | null = null;
  let reviewerQueueTimer: NodeJS.Timeout | null = null;
  let reviewerQueueLastPending: number | null = null;
  let reviewerQueueWarned = false;

  function stopReviewerQueueWatch(ctx?: any): void {
    if (reviewerQueueTimer) {
      clearInterval(reviewerQueueTimer);
      reviewerQueueTimer = null;
    }

    reviewerQueueLastPending = null;
    reviewerQueueWarned = false;

    if (ctx?.ui?.setStatus) {
      ctx.ui.setStatus("bunshin-review-queue", undefined);
    }
  }

  function pollReviewerQueue(ctx: any): void {
    const status = runBunshin(ctx.cwd, ["status"]);
    if (!status.ok) {
      if (!reviewerQueueWarned) {
        reviewerQueueWarned = true;
        ctx.ui.notify(
          `Bunshin reviewer queue watch failed (${status.runner}): ${status.stderr || status.stdout}`,
          "warning",
        );
      }
      return;
    }

    const pending = parseStatusCount(status.stdout, "pending");
    if (pending === undefined) {
      if (!reviewerQueueWarned) {
        reviewerQueueWarned = true;
        ctx.ui.notify("Bunshin reviewer queue watch could not parse pending count.", "warning");
      }
      return;
    }

    reviewerQueueWarned = false;
    ctx.ui.setStatus("bunshin-review-queue", `queue pending: ${pending}`);

    const previous = reviewerQueueLastPending;
    reviewerQueueLastPending = pending;

    if (previous === null) {
      if (pending > 0) {
        const summary = `Bunshin queue has ${pending} pending ${pluralize(pending, "memory")} to review.`;
        ctx.ui.notify(summary, "info");
        post(pi, `${summary}\nRun /bunshin-review-next to process the oldest item.`);
      }
      return;
    }

    if (pending > previous) {
      const delta = pending - previous;
      const summary = `Bunshin queue received ${delta} new ${pluralize(delta, "memory")} (${pending} pending).`;
      ctx.ui.notify(summary, "info");
      post(pi, `${summary}\nRun /bunshin-review-next to process the next item.`);
    }
  }

  function startReviewerQueueWatch(ctx: any): void {
    if (!reviewerQueueWatchEnabled()) {
      return;
    }

    stopReviewerQueueWatch();

    const pollMs = reviewerPollIntervalMs();
    pollReviewerQueue(ctx);

    reviewerQueueTimer = setInterval(() => {
      try {
        pollReviewerQueue(ctx);
      } catch (error) {
        if (!reviewerQueueWarned) {
          reviewerQueueWarned = true;
          ctx.ui.notify(`Bunshin reviewer queue watch crashed: ${(error as Error).message}`, "warning");
        }
      }
    }, pollMs);

    ctx.ui.notify(`Bunshin reviewer queue watch enabled (${pollMs}ms poll).`, "info");
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const init = runBunshin(ctx.cwd, ["init"]);
      if (!init.ok) {
        ctx.ui.notify(`Bunshin init failed (${init.runner}): ${init.stderr || init.stdout}`, "warning");
        return;
      }

      ctx.ui.notify("Bunshin initialized for this session.", "success");
    } catch (error) {
      ctx.ui.notify(`Bunshin init skipped: ${(error as Error).message}`, "warning");
    }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    startReviewerQueueWatch(ctx);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    stopReviewerQueueWatch(ctx);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    currentPrompt = prompt;

    if (process.env.BUNSHIN_INJECT_SEARCH === "0") {
      return;
    }

    const query = toSearchQuery(prompt);
    if (!query) {
      return;
    }

    const limit = process.env.BUNSHIN_SEARCH_LIMIT ?? "3";
    const search = runBunshin(ctx.cwd, ["search", query, "--limit", limit]);

    if (!search.ok) {
      ctx.ui.notify(`Bunshin search failed (${search.runner}): ${search.stderr || search.stdout}`, "warning");
      return;
    }

    if (!search.stdout || search.stdout.includes("No matching memories.")) {
      return;
    }

    return {
      message: {
        customType: "bunshin-memory",
        content: [
          "Relevant Bunshin project memory:",
          "",
          truncate(search.stdout, 1400),
          "",
          "Use this context only if relevant to the current task.",
        ].join("\n"),
        display: true,
      },
    };
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (process.env.BUNSHIN_AUTO_WRITE !== "1") {
      currentPrompt = null;
      return;
    }

    const prompt = currentPrompt;
    currentPrompt = null;

    if (!prompt) {
      return;
    }

    const requestedType = process.env.BUNSHIN_AUTO_TYPE;
    const memoryType = isMemoryType(requestedType) ? requestedType : "fact";
    const summary = toAutoSummary(prompt);
    const detail = truncate(`Auto-captured at agent_end. Prompt: ${normalizeWhitespace(prompt)}`, 400);
    const tags = process.env.BUNSHIN_AUTO_TAGS ?? "pi,auto";

    const write = runBunshin(ctx.cwd, [
      "write",
      memoryType,
      "--summary",
      summary,
      "--detail",
      detail,
      "--tags",
      tags,
    ]);

    if (!write.ok) {
      ctx.ui.notify(`Bunshin auto-write failed (${write.runner}): ${write.stderr || write.stdout}`, "warning");
      return;
    }

    const memoryId = parseMemoryId(`${write.stdout}\n${write.stderr}`) ?? null;
    lastWrittenMemoryId = memoryId;

    ctx.ui.notify(
      memoryId ? `Bunshin wrote local memory ${memoryId}.` : "Bunshin wrote a local memory.",
      "success",
    );

    if (process.env.BUNSHIN_AUTO_PUBLISH !== "1" || !memoryId) {
      return;
    }

    const publish = runBunshin(ctx.cwd, ["publish", memoryId]);
    if (!publish.ok) {
      ctx.ui.notify(`Bunshin auto-publish failed (${publish.runner}): ${publish.stderr || publish.stdout}`, "warning");
      return;
    }

    ctx.ui.notify(`Bunshin published ${memoryId} to review queue.`, "success");
  });

  pi.registerCommand("bunshin-status", {
    description: "Show Bunshin queue and conflict status",
    handler: async (_args: string, ctx: any) => {
      const result = runBunshin(ctx.cwd, ["status"]);
      if (!result.ok) {
        post(pi, `bunshin status failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "bunshin status returned no output");
    },
  });

  pi.registerCommand("bunshin-search", {
    description: "Search Bunshin memory. Usage: /bunshin-search <query>",
    handler: async (args: string, ctx: any) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /bunshin-search <query>", "warning");
        return;
      }

      const result = runBunshin(ctx.cwd, ["search", query, "--include-local", "--limit", "5"]);
      if (!result.ok) {
        post(pi, `bunshin search failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "No matching memories.");
    },
  });

  pi.registerCommand("bunshin-review-next", {
    description: "Review next queue item. Usage: /bunshin-review-next [publish|reject|escalate] [reason...]",
    handler: async (args: string, ctx: any) => {
      const tokens = args.trim() ? args.trim().split(/\s+/) : [];
      const decision = tokens[0];
      const reason = tokens.slice(1).join(" ");

      const commandArgs = ["review", "next"];
      if (decision === "publish" || decision === "reject" || decision === "escalate") {
        commandArgs.push("--decision", decision);
      }
      if (reason) {
        commandArgs.push("--reason", reason);
      }

      const result = runBunshin(ctx.cwd, commandArgs);
      if (!result.ok) {
        post(pi, `bunshin review next failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || "bunshin review next completed");
    },
  });

  pi.registerCommand("bunshin-publish-last", {
    description: "Publish the last auto-written memory from this session",
    handler: async (_args: string, ctx: any) => {
      if (!lastWrittenMemoryId) {
        ctx.ui.notify("No auto-written memory found in this session yet.", "warning");
        return;
      }

      const result = runBunshin(ctx.cwd, ["publish", lastWrittenMemoryId]);
      if (!result.ok) {
        post(pi, `bunshin publish failed (${result.runner})\n${result.stderr || result.stdout}`);
        return;
      }

      post(pi, result.stdout || `Published ${lastWrittenMemoryId}`);
    },
  });
}
