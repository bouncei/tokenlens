import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseSession,
  sumUsage,
  cacheHitRate,
  attributeBySkill,
  isAssistant,
  isAttachment,
} from "../src/parsers/session.js";
import { buildAttachmentEvents, buildAttribution, totalsByCategory } from "../src/attribute.js";
import { encodeProjectDir } from "../src/claude-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "sample.jsonl");

describe("parseSession", () => {
  it("reads every line in the fixture", async () => {
    const rows = await parseSession(FIXTURE);
    expect(rows).toHaveLength(9);
  });

  it("identifies row types correctly", async () => {
    const rows = await parseSession(FIXTURE);
    expect(rows.filter(isAssistant)).toHaveLength(2);
    expect(rows.filter(isAttachment)).toHaveLength(3);
  });
});

describe("sumUsage / cacheHitRate", () => {
  it("sums Anthropic's reported usage across assistant turns", async () => {
    const rows = await parseSession(FIXTURE);
    const t = sumUsage(rows);
    expect(t.assistant_turns).toBe(2);
    expect(t.input_tokens).toBe(3 + 2);
    expect(t.cache_creation_input_tokens).toBe(1000 + 200);
    expect(t.cache_read_input_tokens).toBe(0 + 1000);
    expect(t.output_tokens).toBe(50 + 10);
  });

  it("computes cache hit rate over reads/(reads+writes)", async () => {
    const rows = await parseSession(FIXTURE);
    const t = sumUsage(rows);
    // reads 1000 / (1000 + 1200) = 0.4545...
    expect(cacheHitRate(t)).toBeCloseTo(1000 / 2200, 4);
  });
});

describe("attributeBySkill", () => {
  it("groups output tokens by attributionSkill", async () => {
    const rows = await parseSession(FIXTURE);
    const result = attributeBySkill(rows);
    expect(result).toHaveLength(1);
    expect(result[0].skill).toBe("some-skill");
    expect(result[0].turns).toBe(2);
    expect(result[0].output_tokens).toBe(60);
  });
});

describe("buildAttachmentEvents", () => {
  it("share-attributes by estimated weight, including text-less attachments", async () => {
    const rows = await parseSession(FIXTURE);
    const events = buildAttachmentEvents(rows);
    expect(events).toHaveLength(3);

    // skill_listing + deferred_tools_delta both precede turn 1 (1000 cc).
    // Both get nonzero attribution now: skill_listing by tokenized content,
    // deferred_tools by tools_added * heuristic.
    expect(events[0].category).toBe("skill_listing");
    expect(events[0].isEstimated).toBe(false);
    expect(events[0].attributedCacheCreation).toBeGreaterThan(0);

    expect(events[1].category).toBe("deferred_tools_added");
    expect(events[1].isEstimated).toBe(true);
    expect(events[1].attributedCacheCreation).toBeGreaterThan(0);

    // todo_reminder is solo before turn 2 — its weight is small (heuristic
    // 50 vs observed 200 cc) so it's capped to weight * 1.5 = 75, and the
    // residual goes to invalidation.
    expect(events[2].category).toBe("todo_reminder");
    expect(events[2].attributedCacheCreation).toBeLessThan(200);
  });

  it("buckets residual cache_creation as invalidation_or_growth", async () => {
    const rows = await parseSession(FIXTURE);
    const result = buildAttribution(rows);

    // The fixture's turn-1 cc (1000) far exceeds the cap, so we expect
    // substantial unattributed bytes.
    expect(result.unattributedCacheCreation).toBeGreaterThan(0);
    expect(result.invalidationTurns).toBeGreaterThan(0);

    // The total attributed across events + unattributed should never exceed
    // the total observed cache_creation.
    const attributedSum = result.events.reduce(
      (n, e) => n + e.attributedCacheCreation,
      0,
    );
    const observedTotal = 1000 + 200; // from fixture
    expect(attributedSum + result.unattributedCacheCreation).toBeLessThanOrEqual(
      observedTotal,
    );
  });

  it("rolls up to categories", async () => {
    const rows = await parseSession(FIXTURE);
    const cats = totalsByCategory(buildAttachmentEvents(rows));
    const names = cats.map((c) => c.category).sort();
    expect(names).toEqual(["deferred_tools_added", "skill_listing", "todo_reminder"]);
  });
});

describe("encodeProjectDir", () => {
  it("matches Claude Code's encoding for paths with dots", () => {
    expect(encodeProjectDir("/Users/josh/foo")).toBe("-Users-josh-foo");
    expect(encodeProjectDir("/Users/josh/foo/.bar/x")).toBe("-Users-josh-foo--bar-x");
  });
});
