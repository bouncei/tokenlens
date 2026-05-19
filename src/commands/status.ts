import kleur from "kleur";
import { findActiveSession, listSessionsForCwd } from "../claude-state.js";
import {
  parseSession,
  sumUsage,
  cacheHitRate,
  attributeBySkill,
} from "../parsers/session.js";
import { buildAttachmentEvents, totalsByCategory } from "../attribute.js";
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
  const events = buildAttachmentEvents(rows);
  const categories = totalsByCategory(events);

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
        "  (share-by-bytes of the next assistant turn's cache_creation;",
      ),
    );
    console.log(
      kleur.dim(
        "   sources with no visible text payload show 0 here — see DESIGN.md §5)",
      ),
    );
    const maxCC = Math.max(...categories.map((c) => c.followingCacheCreation), 1);
    for (const c of categories) {
      console.log(
        "  " +
          rightPad(c.category, 26) +
          bar(c.followingCacheCreation, maxCC, 16) +
          "  " +
          leftPad(fmtTokens(c.followingCacheCreation), 7) +
          kleur.dim(`   ${c.events} ev, ${fmtBytes(c.textBytes)} text`),
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
