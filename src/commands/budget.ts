import kleur from "kleur";
import { findActiveSession } from "../claude-state.js";
import { parseSession } from "../parsers/session.js";
import { loadConfig, evaluateBudget, configExists } from "../budget.js";
import { fmtTokens, fmtPct, bar, rightPad, leftPad } from "../format.js";

export interface BudgetOptions {
  cwd?: string;
  sessionPath?: string;
}

export async function runBudget(opts: BudgetOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  if (!(await configExists())) {
    console.error(
      kleur.yellow(
        "tokenlens budget: no ~/.claude/tokenlens.json found. Run `tokenlens init --tier max5` first.",
      ),
    );
    process.exit(1);
  }

  let sessionPath = opts.sessionPath;
  if (!sessionPath) {
    const active = await findActiveSession(cwd);
    if (!active) {
      console.error(
        kleur.yellow(`tokenlens budget: no Claude Code session found for cwd ${cwd}`),
      );
      process.exit(1);
    }
    sessionPath = active.path;
  }

  const config = await loadConfig();
  const rows = await parseSession(sessionPath);
  const e = evaluateBudget(rows, config);

  const dotColor =
    e.decision === "allow"
      ? kleur.green
      : e.decision === "warn"
      ? kleur.yellow
      : e.decision === "ask"
      ? kleur.yellow
      : kleur.red;

  console.log("");
  console.log(kleur.bold("tokenlens budget"));
  console.log("");

  console.log(
    "  " +
      rightPad("decision", 18) +
      dotColor("●") +
      "  " +
      dotColor().bold(e.decision.toUpperCase()) +
      kleur.dim(`  (${e.reason})`),
  );
  console.log(
    "  " +
      rightPad("consumed", 18) +
      leftPad(fmtTokens(e.consumed), 10) +
      kleur.dim("   (input + cache_creation + output)"),
  );
  console.log(
    "  " +
      rightPad("budget", 18) +
      leftPad(fmtTokens(e.budget), 10) +
      kleur.dim(
        config.tier ? `   tier=${config.tier}` : "",
      ),
  );
  console.log(
    "  " +
      rightPad("used", 18) +
      "  " +
      bar(e.consumed, e.budget, 24) +
      "  " +
      leftPad(fmtPct(e.percentUsed), 7),
  );
  console.log("");

  console.log(
    "  " +
      rightPad("warn at", 18) +
      leftPad(config.warningThresholdPercent + "%", 10),
  );
  console.log(
    "  " +
      rightPad("ask at", 18) +
      leftPad(config.askThresholdPercent + "%", 10),
  );
  console.log(
    "  " +
      rightPad("block at", 18) +
      leftPad(config.blockThresholdPercent + "%", 10) +
      kleur.dim(`   hardCap=${config.hardCap}`),
  );
  console.log("");

  if (e.userMessage) {
    console.log(kleur.bold("Message that would be shown to the user:"));
    console.log("  " + kleur.italic(e.userMessage));
    console.log("");
  } else if (e.contextMessage) {
    console.log(kleur.bold("Context that would be injected for Claude:"));
    console.log("  " + kleur.italic(e.contextMessage));
    console.log("");
  }
}
