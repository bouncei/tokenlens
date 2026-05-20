import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfigForTier,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  configExists,
  evaluateBudget,
  TIER_WEEKLY_BUDGETS,
  type TokenlensConfig,
} from "../src/budget.js";
import type { SessionRow } from "../src/parsers/session.js";

function assistantTurn(input: number, cc: number, cr: number, out: number): SessionRow {
  return {
    type: "assistant",
    message: {
      id: "msg",
      model: "claude-opus-4-7",
      role: "assistant" as const,
      type: "message" as const,
      content: [],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cc,
        cache_read_input_tokens: cr,
        output_tokens: out,
      },
    },
  } as unknown as SessionRow;
}

describe("tier defaults", () => {
  it("returns the documented budget per tier", () => {
    expect(TIER_WEEKLY_BUDGETS.pro).toBe(500_000);
    expect(TIER_WEEKLY_BUDGETS.max5).toBe(2_500_000);
    expect(TIER_WEEKLY_BUDGETS.max20).toBe(10_000_000);
    expect(TIER_WEEKLY_BUDGETS.api).toBe(0);
  });

  it("defaultConfigForTier overrides weeklyTokenBudget", () => {
    expect(defaultConfigForTier("pro").weeklyTokenBudget).toBe(500_000);
    expect(defaultConfigForTier("max20").weeklyTokenBudget).toBe(10_000_000);
  });
});

describe("loadConfig + saveConfig", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), "tokenlens-cfg-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("returns DEFAULT_CONFIG when no file exists", async () => {
    const cfg = await loadConfig(home);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("writes and reads back a config", async () => {
    const cfg = defaultConfigForTier("pro");
    await saveConfig(cfg, home);
    const loaded = await loadConfig(home);
    expect(loaded.weeklyTokenBudget).toBe(500_000);
    expect(loaded.tier).toBe("pro");
  });

  it("merges partial saved config over defaults", async () => {
    await fs.mkdir(join(home, ".claude"), { recursive: true });
    await fs.writeFile(
      join(home, ".claude", "tokenlens.json"),
      JSON.stringify({ weeklyTokenBudget: 999_999 }),
    );
    const cfg = await loadConfig(home);
    expect(cfg.weeklyTokenBudget).toBe(999_999);
    expect(cfg.warningThresholdPercent).toBe(DEFAULT_CONFIG.warningThresholdPercent);
  });

  it("configExists detects file presence", async () => {
    expect(await configExists(home)).toBe(false);
    await saveConfig(DEFAULT_CONFIG, home);
    expect(await configExists(home)).toBe(true);
  });
});

describe("evaluateBudget", () => {
  const cfg: TokenlensConfig = {
    weeklyTokenBudget: 1_000_000,
    warningThresholdPercent: 50,
    askThresholdPercent: 80,
    blockThresholdPercent: 95,
    hardCap: false,
    autoDisableUnusedMcpAfterTurns: null,
    telemetry: "off",
  };

  it("allows under warning threshold", () => {
    // 100k consumed, 10% of 1M
    const rows = [assistantTurn(50_000, 50_000, 9_999, 0)];
    const r = evaluateBudget(rows, cfg);
    expect(r.decision).toBe("allow");
    expect(Math.round(r.percentUsed * 100)).toBe(10);
  });

  it("warns between warn and ask thresholds", () => {
    // 600k consumed, 60% of 1M
    const rows = [assistantTurn(300_000, 300_000, 0, 0)];
    const r = evaluateBudget(rows, cfg);
    expect(r.decision).toBe("warn");
    expect(r.contextMessage).toMatch(/60%/);
  });

  it("asks between ask and block thresholds", () => {
    // 850k consumed, 85% of 1M
    const rows = [assistantTurn(400_000, 450_000, 0, 0)];
    const r = evaluateBudget(rows, cfg);
    expect(r.decision).toBe("ask");
    expect(r.userMessage).toMatch(/85%/);
  });

  it("denies at or above block threshold", () => {
    // 1.0M consumed, 100% of 1M
    const rows = [assistantTurn(500_000, 500_000, 0, 0)];
    const r = evaluateBudget(rows, cfg);
    expect(r.decision).toBe("deny");
    expect(r.userMessage).toMatch(/exhausted/);
  });

  it("hardCap=true denies in the ask range too", () => {
    const rows = [assistantTurn(400_000, 450_000, 0, 0)]; // 85%
    const r = evaluateBudget(rows, { ...cfg, hardCap: true });
    expect(r.decision).toBe("deny");
    expect(r.userMessage).toMatch(/hardCap/);
  });

  it("api tier (budget=0) always allows", () => {
    const rows = [assistantTurn(900_000, 900_000, 0, 100_000)]; // way over
    const r = evaluateBudget(rows, { ...cfg, weeklyTokenBudget: 0 });
    expect(r.decision).toBe("allow");
    expect(r.percentUsed).toBe(0);
  });

  it("ignores cache_read in billable tokens", () => {
    // Lots of cache_read shouldn't push us over budget.
    const rows = [assistantTurn(100, 100, 10_000_000, 100)];
    const r = evaluateBudget(rows, cfg);
    expect(r.decision).toBe("allow");
    expect(r.consumed).toBe(300);
  });
});
