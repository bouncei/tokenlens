import kleur from "kleur";
import { findActiveSession, listSessionsForCwd } from "../claude-state.js";
import {
  parseSession,
  sumUsage,
  cacheHitRate,
  attributeBySkill,
} from "../parsers/session.js";
import { buildAttribution, totalsByCategory } from "../attribute.js";
import { analyzeToolUsage } from "../analyze/tools.js";
import { fmtTokens, fmtPct, fmtBytes, rightPad, leftPad, bar } from "../format.js";

export interface StatusOptions {
  cwd?: string;
  sessionPath?: string;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  // Resolve which session to read.
  let sessionPath = opts.sessionPath;
  if (!sessionPath) {
    const active = await findActiveSession(cwd);
    if (!active) {
      console.error(
        kleur.yellow(`tokenlens: no Claude Code session found for cwd ${cwd}`),
      );
      console.error(`Looked under ~/.claude/projects/<encoded(${cwd})>/`);
      process.exit(1);
    }
    sessionPath = active.path;
  }

  const rows = await parseSession(sessionPath);
  const usage = sumUsage(rows);
  const hitRate = cacheHitRate(usage);
  const skills = attributeBySkill(rows);
  const attribution = buildAttribution(rows);
  const categories = totalsByCategory(attribution.events);
  const toolUsage = analyzeToolUsage(rows);

  // ---- Header ----
  console.log("");
  console.log(kleur.bold("tokenlens status"));
  console.log(kleur.dim(`  session  ${sessionPath}`));
  console.log(kleur.dim(`  turns    ${usage.assistant_turns} assistant`));
  console.log("");

  // ---- Token totals ----
  console.log(kleur.bold("Tokens consumed by Anthropic"));
  console.log(
    "  " +
      rightPad("input (uncached)", 22) +
      leftPad(fmtTokens(usage.input_tokens), 10),
  );
  console.log(
    "  " +
      rightPad("cache writes", 22) +
      leftPad(fmtTokens(usage.cache_creation_input_tokens), 10) +
      kleur.dim("   ← bloat lives here"),
  );
  console.log(
    "  " +
      rightPad("cache reads", 22) +
      leftPad(fmtTokens(usage.cache_read_input_tokens), 10) +
      kleur.dim("   ← cheap"),
  );
  console.log(
    "  " +
      rightPad("output", 22) +
      leftPad(fmtTokens(usage.output_tokens), 10),
  );
  console.log(
    "  " +
      rightPad("cache hit rate", 22) +
      leftPad(fmtPct(hitRate), 10),
  );
  console.log("");

  // ---- Skill attribution ----
  if (skills.length > 0) {
    console.log(kleur.bold("Output by attributionSkill"));
    const maxOut = skills[0]?.output_tokens ?? 0;
    for (const s of skills.slice(0, 10)) {
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

  // ---- Attachment categories ----
  if (categories.length > 0) {
    console.log(kleur.bold("Injected context by source"));
    console.log(
      kleur.dim(
        "  (share-by-weight, capped at 1.5x estimated size; residual goes",
      ),
    );
    console.log(
      kleur.dim(
        "   to cache_invalidation_or_growth. ~ = heuristic for text-less)",
      ),
    );
    const allValues = [
      ...categories.map((c) => c.attributedCacheCreation),
      attribution.unattributedCacheCreation,
    ];
    const maxCC = Math.max(...allValues, 1);
    for (const c of categories) {
      const flag = c.anyEstimated ? kleur.yellow(" ~") : "  ";
      console.log(
        "  " +
          rightPad(c.category, 30) +
          bar(c.attributedCacheCreation, maxCC, 16) +
          flag +
          leftPad(fmtTokens(c.attributedCacheCreation), 7) +
          kleur.dim(`   ${c.events} ev, ${fmtBytes(c.textBytes)} text`),
      );
    }
    if (attribution.unattributedCacheCreation > 0) {
      console.log(
        "  " +
          rightPad("cache_invalidation_or_growth", 30) +
          bar(attribution.unattributedCacheCreation, maxCC, 16) +
          kleur.magenta(" !") +
          leftPad(fmtTokens(attribution.unattributedCacheCreation), 7) +
          kleur.dim(
            `   across ${attribution.invalidationTurns} turn${attribution.invalidationTurns === 1 ? "" : "s"}`,
          ),
      );
    }
    console.log("");
  }

  // ---- MCP server usage ----
  const mcpServers = toolUsage.servers.filter((s) => s.server !== "<built-in>");
  if (mcpServers.length > 0) {
    console.log(kleur.bold("MCP servers (loaded vs. invoked)"));
    console.log(
      kleur.dim(
        `  (~${fmtTokens(toolUsage.deadEstimatedTokens)} estimated on tools never called)`,
      ),
    );
    const maxDead = Math.max(...mcpServers.map((s) => s.deadEstimatedTokens), 1);
    for (const s of mcpServers.slice(0, 10)) {
      const status =
        s.toolsInvoked === 0
          ? kleur.red("● never called")
          : s.toolsDead === 0
          ? kleur.green("● fully used")
          : kleur.yellow(`● ${s.toolsInvoked}/${s.toolsLoaded} used`);
      console.log(
        "  " +
          rightPad(s.server, 24) +
          bar(s.deadEstimatedTokens, maxDead, 12) +
          kleur.yellow(" ~") +
          leftPad(fmtTokens(s.deadEstimatedTokens), 7) +
          "   " +
          status,
      );
    }
    if (toolUsage.deadTools.length > 0 && toolUsage.deadTools.length <= 6) {
      console.log(kleur.dim(`  dead tools: ${toolUsage.deadTools.join(", ")}`));
    } else if (toolUsage.deadTools.length > 6) {
      console.log(
        kleur.dim(
          `  ${toolUsage.deadTools.length} dead tools (use --show-dead for full list)`,
        ),
      );
    }
    console.log("");
  }

  // ---- Hints ----
  const allSessions = await listSessionsForCwd(cwd);
  if (allSessions.length > 1) {
    console.log(
      kleur.dim(
        `Found ${allSessions.length} sessions for this cwd. Reading the most recent.`,
      ),
    );
  }
}
