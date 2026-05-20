// Budget evaluation: read user config, compute session + week consumption
// against the configured weeklyTokenBudget, return a structured decision.
//
// Pure logic — no I/O except the config read. The decision is consumed by
// both the `tokenlens budget` CLI subcommand and the PreToolUse hook
// script.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { claudePaths } from "./claude-state.js";
import { type SessionRow, sumUsage } from "./parsers/session.js";

export type Tier = "pro" | "max5" | "max20" | "api";

/** Suggested weekly cap defaults per tier. Calibrated from community-reported
 *  numbers; users can override. */
export const TIER_WEEKLY_BUDGETS: Record<Tier, number> = {
  pro: 500_000,
  max5: 2_500_000,
  max20: 10_000_000,
  api: 0,            // 0 = "no cap; warn on $-cost thresholds instead"
};

export interface TokenlensConfig {
  weeklyTokenBudget: number;
  warningThresholdPercent: number;
  askThresholdPercent: number;
  blockThresholdPercent: number;
  hardCap: boolean;
  autoDisableUnusedMcpAfterTurns: number | null;
  telemetry: "off" | "anonymous";
  tier?: Tier;
}

export const DEFAULT_CONFIG: TokenlensConfig = {
  weeklyTokenBudget: TIER_WEEKLY_BUDGETS.max5,
  warningThresholdPercent: 50,
  askThresholdPercent: 80,
  blockThresholdPercent: 95,
  hardCap: false,
  autoDisableUnusedMcpAfterTurns: null,
  telemetry: "off",
  tier: "max5",
};

export function defaultConfigForTier(tier: Tier): TokenlensConfig {
  return {
    ...DEFAULT_CONFIG,
    weeklyTokenBudget: TIER_WEEKLY_BUDGETS[tier],
    tier,
  };
}

export async function loadConfig(home?: string): Promise<TokenlensConfig> {
  const paths = claudePaths(home);
  const configPath = join(paths.root, "tokenlens.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenlensConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

export async function saveConfig(
  config: TokenlensConfig,
  home?: string,
): Promise<string> {
  const paths = claudePaths(home);
  const configPath = join(paths.root, "tokenlens.json");
  await fs.mkdir(paths.root, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

export async function configExists(home?: string): Promise<boolean> {
  const paths = claudePaths(home);
  try {
    await fs.access(join(paths.root, "tokenlens.json"));
    return true;
  } catch {
    return false;
  }
}

// ---------- Decision ----------

export type BudgetDecision = "allow" | "warn" | "ask" | "deny";

export interface BudgetEvaluation {
  decision: BudgetDecision;
  consumed: number;             // total billable tokens this session
  budget: number;                // weeklyTokenBudget
  percentUsed: number;           // consumed / budget, 0..1+
  reason: string;
  /** Text to surface to Claude (for `additionalContext` on PreToolUse `allow`/`warn`). */
  contextMessage?: string;
  /** Text to surface to the user when blocking or asking. */
  userMessage?: string;
}

/**
 * Compute billable tokens for cap-tracking purposes.
 *
 * The thinking: rate limits are driven by *input + output* on the API side.
 * cache_read is cheap but it still counts toward weekly throughput. We use
 * the most conservative metric (output + cache_creation + input_tokens),
 * intentionally ignoring cache_read since it's cheap and doesn't burn the
 * weekly limit at the same rate. Tunable — users can override later.
 */
export function billableTokens(rows: SessionRow[]): number {
  const u = sumUsage(rows);
  return u.input_tokens + u.cache_creation_input_tokens + u.output_tokens;
}

export function evaluateBudget(
  rows: SessionRow[],
  config: TokenlensConfig,
): BudgetEvaluation {
  const consumed = billableTokens(rows);
  const budget = config.weeklyTokenBudget;

  // API tier (budget=0) is "unlimited" — always allow.
  if (budget <= 0) {
    return {
      decision: "allow",
      consumed,
      budget,
      percentUsed: 0,
      reason: "API tier — no cap configured",
    };
  }

  const percent = consumed / budget;
  const pct = Math.round(percent * 100);

  if (pct < config.warningThresholdPercent) {
    return {
      decision: "allow",
      consumed,
      budget,
      percentUsed: percent,
      reason: `under warning threshold (${pct}% < ${config.warningThresholdPercent}%)`,
    };
  }

  if (pct < config.askThresholdPercent) {
    return {
      decision: "warn",
      consumed,
      budget,
      percentUsed: percent,
      reason: `between warning and ask threshold`,
      contextMessage: `tokenlens: you're at ~${pct}% of your weekly token budget. Consider wrapping this task.`,
    };
  }

  if (pct < config.blockThresholdPercent) {
    if (config.hardCap) {
      return {
        decision: "deny",
        consumed,
        budget,
        percentUsed: percent,
        reason: `hardCap=true at ${pct}%`,
        userMessage: `tokenlens: weekly budget at ${pct}% with hardCap=true. Raise weeklyTokenBudget in ~/.claude/tokenlens.json or wait for the window to reset.`,
      };
    }
    return {
      decision: "ask",
      consumed,
      budget,
      percentUsed: percent,
      reason: `between ask and block threshold`,
      userMessage: `tokenlens: this turn will push you to ~${pct}% of your weekly cap (${consumed.toLocaleString()} / ${budget.toLocaleString()} tokens). Continue?`,
    };
  }

  return {
    decision: "deny",
    consumed,
    budget,
    percentUsed: percent,
    reason: `at or above block threshold (${pct}% >= ${config.blockThresholdPercent}%)`,
    userMessage: `tokenlens: weekly budget exhausted at ${pct}%. Adjust weeklyTokenBudget in ~/.claude/tokenlens.json or wait for the rate-limit window to reset.`,
  };
}
