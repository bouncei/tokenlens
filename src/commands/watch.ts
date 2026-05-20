// Live-tail the active session jsonl and re-render the status panel
// whenever the file grows. Uses chokidar for reliable cross-platform
// file watching.

import { promises as fs } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import kleur from "kleur";
import { findActiveSession } from "../claude-state.js";
import {
  parseSession,
  sumUsage,
  cacheHitRate,
  attributeBySkill,
} from "../parsers/session.js";
import { buildAttribution, totalsByCategory } from "../attribute.js";
import { fmtTokens, fmtPct, fmtBytes, rightPad, leftPad, bar } from "../format.js";

export interface WatchOptions {
  cwd?: string;
  sessionPath?: string;
  pollMs?: number;
}

export async function runWatch(opts: WatchOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  let sessionPath = opts.sessionPath;
  if (!sessionPath) {
    const active = await findActiveSession(cwd);
    if (!active) {
      console.error(
        kleur.yellow(`tokenlens: no Claude Code session found for cwd ${cwd}`),
      );
      process.exit(1);
    }
    sessionPath = active.path;
  }

  // Initial render.
  await render(sessionPath);

  // Watch for appends. chokidar polls on macOS to handle vim-style atomic
  // writes; for plain appends fs.watch would suffice but chokidar is the
  // safer bet across editors and FS types.
  let inFlight = false;
  let pending = false;

  const watcher: FSWatcher = chokidar.watch(sessionPath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    usePolling: opts.pollMs !== undefined,
    interval: opts.pollMs,
  });

  watcher.on("change", async () => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await render(sessionPath!);
      while (pending) {
        pending = false;
        await render(sessionPath!);
      }
    } finally {
      inFlight = false;
    }
  });

  process.on("SIGINT", () => {
    watcher.close().finally(() => process.exit(0));
  });

  // Keep the event loop alive.
  await new Promise<void>(() => {});
}

function clear() {
  // ANSI clear screen + home cursor. Avoids ink dependency for v1.
  process.stdout.write("\x1b[2J\x1b[H");
}

async function render(sessionPath: string): Promise<void> {
  const stat = await fs.stat(sessionPath);
  const rows = await parseSession(sessionPath);
  const usage = sumUsage(rows);
  const hitRate = cacheHitRate(usage);
  const skills = attributeBySkill(rows);
  const attribution = buildAttribution(rows);
  const categories = totalsByCategory(attribution.events);

  clear();
  const now = new Date().toLocaleTimeString();
  console.log(
    kleur.bold("tokenlens watch") +
      kleur.dim(`   updated ${now}   ${fmtBytes(stat.size)} on disk`),
  );
  console.log("");

  console.log(kleur.bold("Usage"));
  console.log(
    "  " + rightPad("turns", 22) + leftPad(usage.assistant_turns.toString(), 10),
  );
  console.log(
    "  " + rightPad("input (uncached)", 22) + leftPad(fmtTokens(usage.input_tokens), 10),
  );
  console.log(
    "  " +
      rightPad("cache writes", 22) +
      leftPad(fmtTokens(usage.cache_creation_input_tokens), 10) +
      kleur.dim("   ← bloat"),
  );
  console.log(
    "  " +
      rightPad("cache reads", 22) +
      leftPad(fmtTokens(usage.cache_read_input_tokens), 10) +
      kleur.dim("   ← cheap"),
  );
  console.log("  " + rightPad("output", 22) + leftPad(fmtTokens(usage.output_tokens), 10));
  console.log("  " + rightPad("cache hit rate", 22) + leftPad(fmtPct(hitRate), 10));
  console.log("");

  if (skills.length > 0) {
    console.log(kleur.bold("Output by skill"));
    const maxOut = skills[0]?.output_tokens ?? 0;
    for (const s of skills.slice(0, 5)) {
      console.log(
        "  " +
          rightPad(s.skill, 24) +
          bar(s.output_tokens, maxOut, 16) +
          "  " +
          leftPad(fmtTokens(s.output_tokens), 7) +
          kleur.dim(`   (${s.turns} turn${s.turns === 1 ? "" : "s"})`),
      );
    }
    console.log("");
  }

  if (categories.length > 0) {
    console.log(kleur.bold("Injected by source"));
    const allValues = [
      ...categories.map((c) => c.attributedCacheCreation),
      attribution.unattributedCacheCreation,
    ];
    const maxCC = Math.max(...allValues, 1);
    for (const c of categories.slice(0, 6)) {
      const flag = c.anyEstimated ? kleur.yellow(" ~") : "  ";
      console.log(
        "  " +
          rightPad(c.category, 30) +
          bar(c.attributedCacheCreation, maxCC, 16) +
          flag +
          leftPad(fmtTokens(c.attributedCacheCreation), 7),
      );
    }
    if (attribution.unattributedCacheCreation > 0) {
      console.log(
        "  " +
          rightPad("cache_invalidation_or_growth", 30) +
          bar(attribution.unattributedCacheCreation, maxCC, 16) +
          kleur.magenta(" !") +
          leftPad(fmtTokens(attribution.unattributedCacheCreation), 7),
      );
    }
    console.log("");
  }

  console.log(kleur.dim(`watching ${sessionPath}`));
  console.log(kleur.dim("ctrl-c to stop"));
}
