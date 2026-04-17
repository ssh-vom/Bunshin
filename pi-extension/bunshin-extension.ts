import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";

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

function isMemoryType(value: string | undefined): value is "worked" | "failed" | "fact" {
  return value === "worked" || value === "failed" || value === "fact";
}

const REVIEWER_ONLY_TOOLS = ["bunshin_peek", "bunshin_review", "bunshin_compact"] as const;

function isReviewerSession(): boolean {
  const agentName = process.env.BUNSHIN_AGENT_NAME?.trim();
  const reviewerName = process.env.BUNSHIN_REVIEWER_NAME?.trim();
  return !!agentName && !!reviewerName && agentName === reviewerName;
}

function ensureReviewerToolAccess(): void {
  if (!isReviewerSession()) {
    throw new Error("Reviewer-only Bunshin tool. Workers must not call bunshin_peek, bunshin_review, or bunshin_compact.");
  }
}

function formatBunshinFailure(args: string[], result: BunshinCommandResult): string {
  const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
  return `bunshin ${args.join(" ")} failed (${result.runner}): ${detail}`;
}

function runBunshinTool(ctx: any, args: string[], emptyMessage: string) {
  const result = runBunshin(ctx.cwd, args);
  if (!result.ok) {
    throw new Error(formatBunshinFailure(args, result));
  }

  return {
    content: [{ type: "text", text: result.stdout || emptyMessage }],
    details: {
      command: `bunshin ${args.join(" ")}`,
      runner: result.runner,
      exitCode: result.exitCode,
      stderr: result.stderr || undefined,
    },
  };
}

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function envIntInRange(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parsePendingCount(statusStdout: string): number {
  for (const line of statusStdout.split(/\r?\n/)) {
    const match = line.match(/^pending:\s*(\d+)/);
    if (match) return Number.parseInt(match[1] ?? "0", 10);
  }
  return 0;
}

interface ReviewerWatchState {
  timer: NodeJS.Timeout | null;
  running: boolean;
}

function buildReviewQueuePrompt(batchSize: number): string {
  return [
    `Review up to ${batchSize} Bunshin queue item(s). Stop early if the queue becomes empty.`,
    "For each item:",
    "1. Call bunshin_peek to claim and inspect the next queue item.",
    "2. Analyze the candidate against the existing topic content.",
    "3. Call bunshin_review with the queueId, a decision (publish/reject/escalate), and a concise reason.",
    "4. Repeat until you have processed the batch or bunshin_peek reports there are no pending queue items.",
  ].join("\n");
}

function startReviewerQueueWatch(pi: any, ctx: any): ReviewerWatchState {
  const state: ReviewerWatchState = { timer: null, running: false };

  const autoProcess = envFlag("BUNSHIN_REVIEWER_AUTO_PROCESS");
  const pollMs = envIntInRange("BUNSHIN_REVIEWER_POLL_MS", 4000, 1000, 60000);
  const batchSize = envIntInRange("BUNSHIN_REVIEWER_AUTO_BATCH", 10, 1, 100);

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const status = runBunshin(ctx.cwd, ["status"]);
      if (!status.ok) {
        ctx.ui?.notify?.(
          `Bunshin reviewer watch: status failed: ${status.stderr || status.stdout}`,
          "warning",
        );
        return;
      }

      const pending = parsePendingCount(status.stdout);
      if (pending <= 0) return;

      if (!autoProcess) {
        ctx.ui?.notify?.(
          `Bunshin reviewer watch: ${pending} pending item(s). Run bunshin_review to drain.`,
          "info",
        );
        return;
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }

      pi.sendUserMessage(buildReviewQueuePrompt(batchSize));
      ctx.ui?.notify?.(
        `Bunshin reviewer queued an intelligent review pass for ${Math.min(batchSize, pending)} item(s).`,
        "info",
      );
    } catch (error) {
      ctx.ui?.notify?.(
        `Bunshin reviewer watch error: ${(error as Error).message}`,
        "warning",
      );
    } finally {
      state.running = false;
    }
  };

  state.timer = setInterval(() => {
    void tick();
  }, pollMs);
  if (typeof state.timer.unref === "function") state.timer.unref();

  void tick();

  return state;
}

export default function bunshinExtension(pi: any) {
  pi.registerTool({
    name: "bunshin_find",
    label: "Bunshin Find",
    description:
      "Ripgrep-backed search over Bunshin memory. Searches reviewed project memory (shared/project) AND this sandbox's local notes by default, so you see both promoted bullets and your own in-progress captures. Multi-word queries are OR-matched across tokens. Omit the query to list recent topic files. Pass includeLocal=false to restrict to reviewed shared memory only.",
    promptSnippet: "Search Bunshin project + local memory with ripgrep keywords",
    promptGuidelines: [
      "Before starting any non-trivial task, run bunshin_find with distinct keywords drawn from the task, files you're about to touch, or tags you expect were used at capture time.",
      "Multi-word queries are OR-matched per token, so pass individual keywords rather than full sentences.",
      "If the first query returns nothing relevant, retry with different variants before concluding there is no prior memory: try (1) a path substring via the `path` param, (2) a tag via the `tag` param, (3) synonyms or component names. Only proceed without prior context after at least two varied attempts come up empty.",
      "The tool already includes this sandbox's local notes by default. Only pass includeLocal=false when you specifically want to see reviewed/promoted memory in isolation.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Search keywords. Whitespace-separated tokens are OR-matched. Omit to list recent topic files.",
        }),
      ),
      includeLocal: Type.Optional(
        Type.Boolean({
          description:
            "Whether to also search this sandbox's local notes. Defaults to true; set to false to restrict to reviewed shared memory.",
        }),
      ),
      type: Type.Optional(Type.String({ description: "Filter by memory type: worked | failed | fact" })),
      tag: Type.Optional(Type.String({ description: "Exact tag filter" })),
      path: Type.Optional(Type.String({ description: "Project path substring filter" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results", minimum: 1, maximum: 50 })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        query?: string;
        includeLocal?: boolean;
        type?: string;
        tag?: string;
        path?: string;
        limit?: number;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const args = ["find"];

      const query = params.query?.trim();
      if (query) {
        args.push(query);
      }

      if (params.includeLocal !== false) {
        args.push("--include-local");
      }

      const type = params.type?.trim();
      if (type) {
        if (!isMemoryType(type)) {
          throw new Error(`Invalid memory type: ${type}. Use worked | failed | fact.`);
        }
        args.push("--type", type);
      }

      const tag = params.tag?.trim();
      if (tag) {
        args.push("--tag", tag);
      }

      const pathFilter = params.path?.trim();
      if (pathFilter) {
        args.push("--path", pathFilter);
      }

      if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
        const limit = Math.min(50, Math.max(1, Math.floor(params.limit)));
        args.push("--limit", `${limit}`);
      } else if (!query) {
        args.push("--limit", "5");
      }

      return runBunshinTool(ctx, args, "No matching memories.");
    },
  });

  pi.registerTool({
    name: "bunshin_note",
    label: "Bunshin Note",
    description:
      "Record a reusable project insight as a local Bunshin memory. Pass submit=true to also enqueue it for shared review.",
    promptSnippet: "Capture a reusable project insight as a Bunshin memory",
    promptGuidelines: [
      "After a task, ask yourself whether you learned something reusable. If yes, write one concise note.",
      "Use type=fact for stable guidance, worked for a confirmed fix, failed for a failure mode worth remembering.",
      "Attach paths and tags when they would help a future bunshin_find query locate this note.",
      "Pass submit=true only when the insight is clearly useful across sessions; otherwise keep it local.",
    ],
    parameters: Type.Object({
      type: Type.Optional(Type.String({ description: "Memory type: worked | failed | fact (default: fact)" })),
      summary: Type.String({ description: "Required summary sentence" }),
      detail: Type.Optional(Type.String({ description: "Optional detail" })),
      takeaway: Type.Optional(Type.String({ description: "Optional takeaway" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Optional project paths" })),
      topic: Type.Optional(Type.String({ description: "Optional explicit topic override" })),
      submit: Type.Optional(Type.Boolean({ description: "Submit to shared review queue after writing" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        type?: string;
        summary: string;
        detail?: string;
        takeaway?: string;
        tags?: string[];
        paths?: string[];
        topic?: string;
        submit?: boolean;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const summary = params.summary?.trim();
      if (!summary) {
        throw new Error("bunshin_note requires a non-empty summary");
      }

      const requestedType = params.type?.trim();
      const memoryType = requestedType ? (isMemoryType(requestedType) ? requestedType : null) : "fact";
      if (!memoryType) {
        throw new Error(`Invalid memory type: ${requestedType}. Use worked | failed | fact.`);
      }

      const args = ["note", memoryType, "--summary", summary];

      const detail = params.detail?.trim();
      if (detail) args.push("--detail", detail);

      const takeaway = params.takeaway?.trim();
      if (takeaway) args.push("--takeaway", takeaway);

      const tags = (params.tags ?? []).map((item) => item.trim()).filter(Boolean);
      if (tags.length > 0) args.push("--tags", tags.join(","));

      const paths = (params.paths ?? []).map((item) => item.trim()).filter(Boolean);
      if (paths.length > 0) args.push("--paths", paths.join(","));

      const topic = params.topic?.trim();
      if (topic) args.push("--topic", topic);

      if (params.submit) args.push("--submit");

      return runBunshinTool(ctx, args, "bunshin note completed");
    },
  });

  function parsePeekOutput(stdout: string): {
    queueId: string;
    candidate: any;
    topic: { title: string; slug: string };
    existingTopicContent?: string | null;
  } | null {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.queueId && parsed.candidate && parsed.topic?.title && parsed.topic?.slug) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  pi.registerTool({
    name: "bunshin_peek",
    label: "Bunshin Peek",
    description:
      "Claim the next pending queue item and return its content for LLM review analysis. Returns the candidate memory and existing topic content. The item is moved to 'claimed' status but not processed - you must later call bunshin_review to complete it.",
    promptSnippet: "Claim and inspect the next Bunshin queue item for intelligent review",
    promptGuidelines: [
      "Call this to get the next item needing review along with existing topic context.",
      "Analyze the candidate memory against existing topic content for duplicates, conflicts, or consolidation opportunities.",
      "Consider: Is this a duplicate? Does it conflict? Should it merge with existing bullets? Which section (working/long-term/history)?",
      "After analysis, call bunshin_review with the returned queueId, your decision, and reasoning.",
    ],
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: {},
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      ensureReviewerToolAccess();

      const peekResult = runBunshin(ctx.cwd, ["review", "--peek"]);

      if (!peekResult.ok) {
        throw new Error(formatBunshinFailure(["review", "--peek"], peekResult));
      }

      if (!peekResult.stdout || peekResult.stdout.includes("No pending queue items")) {
        return {
          content: [{ type: "text", text: "No pending queue items to review." }],
          details: { queueEmpty: true },
        };
      }

      const parsed = parsePeekOutput(peekResult.stdout);
      if (!parsed) {
        throw new Error(`bunshin review --peek returned malformed JSON: ${peekResult.stdout}`);
      }

      const topicContent = parsed.existingTopicContent ?? null;
      const analysisPrompt = `## Review Task

You are reviewing a Bunshin memory for consolidation into the project knowledge base.

### Candidate Memory
- **Queue ID:** ${parsed.queueId}
- **Candidate ID:** ${parsed.candidate.id}
- **Type:** ${parsed.candidate.type || "unknown"}
- **Topic:** ${parsed.topic.title} (${parsed.topic.slug})

**Summary:**
${parsed.candidate.summary || "(see candidate body)"}

**Full Content:**
\`\`\`markdown
${parsed.candidate.markdown || parsed.candidate.rawBody || "(content not available)"}
\`\`\`

### Existing Topic Content
${topicContent ? `\`\`\`markdown
${topicContent}
\`\`\`` : "_(No existing topic file - this will be a new topic.)_"}

### Analysis Instructions
Please analyze:
1. **Duplicate detection:** Is this memory already captured (exactly or semantically) in the topic?
2. **Conflicts:** Does this contradict any existing knowledge?
3. **Consolidation:** Should this merge with, update, or replace existing bullets?
4. **Section placement:** Which section is most appropriate?
   - **Working:** Active experiments, temporary solutions, in-progress work
   - **Long-term:** Confirmed patterns, stable facts, established solutions
   - **History:** Superseded approaches, past attempts, deprecated knowledge

### Next Step
After analysis, call **bunshin_review** with:
- **queueId:** "${parsed.queueId}"
- **decision:** "publish" | "reject" | "escalate"
- **reason:** Your reasoning for the decision
`;

      return {
        content: [{ type: "text", text: analysisPrompt }],
        details: {
          queueId: parsed.queueId,
          candidate: parsed.candidate,
          topic: parsed.topic,
          topicContent,
        },
      };
    },
  });

  pi.registerTool({
    name: "bunshin_review",
    label: "Bunshin Review",
    description:
      "Complete review of a claimed queue item. Only call this after bunshin_peek when you are the reviewer agent. Executes publish, reject, or escalate decision.",
    promptSnippet: "Complete Bunshin review with decision (publish/reject/escalate)",
    promptGuidelines: [
      "Only call after bunshin_peek has claimed an item.",
      "Always pass the queueId returned by bunshin_peek so the claimed item is completed correctly.",
      "Provide clear reasoning for your decision.",
      "Use 'publish' when the memory adds value (new insight, refinement, or update).",
      "Use 'reject' for duplicates, spam, or clearly irrelevant content.",
      "Use 'escalate' for conflicts needing human resolution or uncertain classification.",
      "If the review output says should_compact: yes, read the topic file, consolidate it, then call bunshin_compact with the full rewritten topic markdown.",
    ],
    parameters: Type.Object({
      queueId: Type.String({ description: "Queue ID returned by bunshin_peek" }),
      decision: Type.String({ description: "Decision: publish | reject | escalate" }),
      reason: Type.String({ description: "Required reasoning for the decision" }),
      reviewer: Type.Optional(Type.String({ description: "Optional reviewer identity override" })),
    }),
    async execute(
      _toolCallId: string,
      params: { queueId: string; decision: string; reason: string; reviewer?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) {
      ensureReviewerToolAccess();

      const queueId = params.queueId?.trim();
      if (!queueId) {
        throw new Error("queueId is required. Pass the queueId returned by bunshin_peek.");
      }

      const decision = params.decision?.trim();
      if (!decision || !["publish", "reject", "escalate"].includes(decision)) {
        throw new Error(`Invalid decision: ${decision}. Must be publish | reject | escalate.`);
      }

      const reason = params.reason?.trim();
      if (!reason) {
        throw new Error("Reason is required for all review decisions.");
      }

      const args = ["review", "--queue-id", queueId, "--decision", decision, "--reason", reason];

      const reviewer = params.reviewer?.trim();
      if (reviewer) args.push("--reviewer", reviewer);

      return runBunshinTool(ctx, args, "No pending queue items.");
    },
  });

  pi.registerTool({
    name: "bunshin_compact",
    label: "Bunshin Compact",
    description:
      "Rewrite a shared Bunshin topic file after consolidating duplicate or stale bullets. Use when a topic has accumulated enough reviewed updates to warrant compaction.",
    promptSnippet: "Rewrite and consolidate a Bunshin topic file",
    promptGuidelines: [
      "Use this only for reviewer-owned shared topic files.",
      "Call this after reading the topic file and rewriting it into canonical Working / Long-term / History sections.",
      "This tool resets review_count_since_compaction to 0 automatically.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the shared Bunshin topic markdown file to rewrite",
      }),
      content: Type.String({ description: "Full rewritten topic markdown" }),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; content: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: any,
    ) {
      ensureReviewerToolAccess();

      const topicPath = params.path?.trim();
      if (!topicPath) {
        throw new Error("path is required");
      }
      if (!path.isAbsolute(topicPath)) {
        throw new Error("path must be an absolute path");
      }

      const rawContent = params.content?.trim();
      if (!rawContent) {
        throw new Error("content is required");
      }

      const normalizedBody = rawContent
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        .trim();

      const requiredSections = ["# Topic:", "## Working", "## Long-term", "## History"];
      for (const section of requiredSections) {
        if (!normalizedBody.includes(section)) {
          throw new Error(`content must include ${section}`);
        }
      }

      const finalContent = `---\nreview_count_since_compaction: 0\n---\n\n${normalizedBody}\n`;
      writeFileSync(topicPath, finalContent, "utf8");

      return {
        content: [
          {
            type: "text",
            text: [
              "Compacted Bunshin topic and reset review_count_since_compaction to 0.",
              `path: ${topicPath}`,
            ].join("\n"),
          },
        ],
        details: {
          path: topicPath,
          resetReviewCountSinceCompaction: true,
        },
      };
    },
  });

  let reviewerWatch: ReviewerWatchState | null = null;

  pi.on("session_start", async (_event: any, ctx: any) => {
    const reviewerSession = isReviewerSession();
    const activeTools = pi.getActiveTools();
    const filteredTools = reviewerSession
      ? activeTools
      : activeTools.filter((name: string) => !REVIEWER_ONLY_TOOLS.includes(name as (typeof REVIEWER_ONLY_TOOLS)[number]));
    if (filteredTools.length !== activeTools.length) {
      pi.setActiveTools(filteredTools);
    }

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

    if (reviewerSession && envFlag("BUNSHIN_REVIEWER_WATCH_QUEUE") && !reviewerWatch) {
      reviewerWatch = startReviewerQueueWatch(pi, ctx);
      const autoNote = envFlag("BUNSHIN_REVIEWER_AUTO_PROCESS") ? " (auto-process on)" : "";
      ctx.ui?.notify?.(`Bunshin reviewer watching queue${autoNote}.`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    if (reviewerWatch?.timer) {
      clearInterval(reviewerWatch.timer);
      reviewerWatch.timer = null;
    }
    reviewerWatch = null;
  });
}
