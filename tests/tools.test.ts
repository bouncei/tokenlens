import { describe, it, expect } from "vitest";
import { analyzeToolUsage, serverFromToolName } from "../src/analyze/tools.js";
import type { SessionRow } from "../src/parsers/session.js";

function attachment(addedNames: string[], removedNames: string[] = []): SessionRow {
  return {
    type: "attachment",
    uuid: "att-" + Math.random(),
    attachment: {
      type: "deferred_tools_delta",
      addedNames,
      addedLines: addedNames,
      removedNames,
      readdedNames: [],
      pendingMcpServers: [],
    },
  } as unknown as SessionRow;
}

function assistant(toolNames: string[]): SessionRow {
  return {
    type: "assistant",
    uuid: "as-" + Math.random(),
    message: {
      id: "msg",
      model: "claude-opus-4-7",
      role: "assistant" as const,
      type: "message" as const,
      content: toolNames.map((name) => ({
        type: "tool_use" as const,
        id: "t-" + name,
        name,
        input: {},
      })),
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  } as unknown as SessionRow;
}

describe("serverFromToolName", () => {
  it("extracts mcp server name", () => {
    expect(serverFromToolName("mcp__filesystem__read_file")).toBe("filesystem");
    expect(serverFromToolName("mcp__memory__add_observations")).toBe("memory");
    expect(serverFromToolName("mcp__server_with_underscores__do_thing")).toBe(
      "server_with_underscores",
    );
  });

  it("returns <built-in> for non-mcp tools", () => {
    expect(serverFromToolName("Bash")).toBe("<built-in>");
    expect(serverFromToolName("Read")).toBe("<built-in>");
    expect(serverFromToolName("TodoWrite")).toBe("<built-in>");
  });
});

describe("analyzeToolUsage", () => {
  it("computes loaded, invoked, dead sets across the session", () => {
    const rows: SessionRow[] = [
      attachment([
        "mcp__filesystem__read_file",
        "mcp__filesystem__write_file",
        "mcp__memory__add_observations",
      ]),
      assistant(["mcp__filesystem__read_file"]),                  // calls fs.read
      assistant(["mcp__filesystem__read_file", "Bash"]),          // calls fs.read again
    ];
    const usage = analyzeToolUsage(rows);

    expect(usage.loaded.size).toBe(3);
    expect(usage.invoked.has("mcp__filesystem__read_file")).toBe(true);
    expect(usage.invoked.has("Bash")).toBe(true);
    expect(usage.deadTools).toEqual([
      "mcp__filesystem__write_file",
      "mcp__memory__add_observations",
    ]);
  });

  it("rolls up dead-token cost per server", () => {
    const rows: SessionRow[] = [
      attachment([
        "mcp__filesystem__read_file",
        "mcp__filesystem__write_file",
        "mcp__memory__add_observations",
        "mcp__memory__create_relations",
        "mcp__memory__delete_entities",
      ]),
      assistant(["mcp__filesystem__read_file"]),
    ];
    const usage = analyzeToolUsage(rows);
    const byName = new Map(usage.servers.map((s) => [s.server, s]));

    expect(byName.get("filesystem")!.toolsLoaded).toBe(2);
    expect(byName.get("filesystem")!.toolsInvoked).toBe(1);
    expect(byName.get("filesystem")!.toolsDead).toBe(1);
    expect(byName.get("memory")!.toolsDead).toBe(3);
    expect(byName.get("memory")!.deadEstimatedTokens).toBeGreaterThan(0);
    // Memory is sorted before filesystem because it has more dead tokens.
    expect(usage.servers[0].server).toBe("memory");
  });

  it("respects removedNames in the cumulative loaded set", () => {
    const rows: SessionRow[] = [
      attachment(["mcp__foo__a", "mcp__foo__b"]),
      attachment([], ["mcp__foo__b"]),
      assistant(["mcp__foo__a"]),
    ];
    const usage = analyzeToolUsage(rows);
    expect(usage.loaded.has("mcp__foo__b")).toBe(false);
    expect(usage.deadTools).toEqual([]);
  });

  it("estimates 0 dead tokens when every loaded tool is invoked", () => {
    const rows: SessionRow[] = [
      attachment(["mcp__foo__a"]),
      assistant(["mcp__foo__a"]),
    ];
    const usage = analyzeToolUsage(rows);
    expect(usage.deadEstimatedTokens).toBe(0);
    expect(usage.deadTools).toEqual([]);
  });
});
