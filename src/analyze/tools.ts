// Cross-reference tools that were *loaded* into context (via
// deferred_tools_delta attachments) against tools the model actually
// *invoked* (via tool_use content blocks on assistant turns). Tools in
// the first set but not the second are dead weight — they paid context
// rent without doing any work.
//
// Tool names follow the convention `mcp__<server>__<tool>` for MCP-sourced
// tools; we extract the server slice so users can act per-server (e.g.,
// "filesystem cost you 18k tokens and was never called — drop it from
// .mcp.json").

import {
  type AttachmentRow,
  type AssistantRow,
  type SessionRow,
  isAssistant,
  isAttachment,
} from "../parsers/session.js";
import { TOOL_DEFINITION_TOKEN_ESTIMATE } from "../tokens/count.js";

export interface ToolUsage {
  /** Tools that were added (cumulative) across all deferred_tools_delta. */
  loaded: Set<string>;
  /** Tools that the model actually called at least once. */
  invoked: Set<string>;
  /** Loaded ∖ invoked — paid context rent, did no work. */
  deadTools: string[];
  /** Per-server roll-up. */
  servers: ServerUsage[];
  /** Sum of estimated tokens spent on dead tool definitions. */
  deadEstimatedTokens: number;
}

export interface ServerUsage {
  server: string;                   // "filesystem", "memory", "playwright"... or "<no-server>"
  toolsLoaded: number;
  toolsInvoked: number;
  toolsDead: number;
  deadToolNames: string[];
  estimatedTokens: number;
  deadEstimatedTokens: number;
}

// MCP tool convention: `mcp__<server>__<tool>` where <server> may contain
// single underscores but not `__`. Non-greedy capture stops at the first
// `__` after the `mcp__` prefix.
const MCP_PATTERN = /^mcp__(.+?)__/;

/**
 * Parse `mcp__<server>__<tool>` → server. Returns `<built-in>` for tools
 * without the `mcp__` prefix (e.g., Bash, Read, Write — base CC tools
 * surfaced via ToolSearch).
 */
export function serverFromToolName(toolName: string): string {
  const m = toolName.match(MCP_PATTERN);
  if (m) return m[1]!;
  return "<built-in>";
}

export function analyzeToolUsage(rows: SessionRow[]): ToolUsage {
  const loaded = new Set<string>();
  const invoked = new Set<string>();

  for (const row of rows) {
    if (isAttachment(row)) {
      const att = (row as AttachmentRow).attachment;
      if (att.type !== "deferred_tools_delta") continue;
      for (const name of att.addedNames ?? []) loaded.add(name);
      for (const name of att.removedNames ?? []) loaded.delete(name);
      for (const name of att.readdedNames ?? []) loaded.add(name);
      continue;
    }
    if (!isAssistant(row)) continue;
    const content = (row as AssistantRow).message.content ?? [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") {
        const name = (block as { name?: string }).name;
        if (name) invoked.add(name);
      }
    }
  }

  const deadTools = [...loaded].filter((t) => !invoked.has(t)).sort();
  const deadEstimatedTokens = deadTools.length * TOOL_DEFINITION_TOKEN_ESTIMATE;

  // Per-server roll-up.
  const serverMap = new Map<string, ServerUsage>();
  for (const name of loaded) {
    const server = serverFromToolName(name);
    const entry = serverMap.get(server) ?? {
      server,
      toolsLoaded: 0,
      toolsInvoked: 0,
      toolsDead: 0,
      deadToolNames: [],
      estimatedTokens: 0,
      deadEstimatedTokens: 0,
    };
    entry.toolsLoaded++;
    entry.estimatedTokens += TOOL_DEFINITION_TOKEN_ESTIMATE;
    if (invoked.has(name)) {
      entry.toolsInvoked++;
    } else {
      entry.toolsDead++;
      entry.deadToolNames.push(name);
      entry.deadEstimatedTokens += TOOL_DEFINITION_TOKEN_ESTIMATE;
    }
    serverMap.set(server, entry);
  }

  const servers = [...serverMap.values()].sort(
    (a, b) => b.deadEstimatedTokens - a.deadEstimatedTokens,
  );

  return {
    loaded,
    invoked,
    deadTools,
    servers,
    deadEstimatedTokens,
  };
}
