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
import { buildAttachmentEvents, totalsByCategory } from "../src/attribute.js";
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
  it("share-attributes the next assistant turn's cache_creation across grouped attachments", async () => {
    const rows = await parseSession(FIXTURE);
    const events = buildAttachmentEvents(rows);
    expect(events).toHaveLength(3);

    // skill_listing (has content) and deferred_tools_delta (no content) both
    // precede assistant turn 1 with 1000 cache_creation. Share-by-bytes
    // gives skill_listing 100%, deferred_tools_added 0%.
    expect(events[0].category).toBe("skill_listing");
    expect(events[0].followingTurnCacheCreation).toBe(1000);
    expect(events[1].category).toBe("deferred_tools_added");
    expect(events[1].followingTurnCacheCreation).toBe(0);

    // todo_reminder is solo before turn 2: gets all 200.
    expect(events[2].category).toBe("todo_reminder");
    expect(events[2].followingTurnCacheCreation).toBe(200);
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
