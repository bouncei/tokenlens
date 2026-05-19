// Typed parser for Claude Code session jsonl files at
// ~/.claude/projects/<encoded-cwd>/*.jsonl
//
// Schema reverse-engineered on Claude Code v2.1.138 (2026-05-19).
// See docs/SCHEMA.md for the underlying field map.
//
// This module is intentionally permissive: any line whose shape we don't
// recognize is preserved as a RawRow so we don't lose data. Strict mode is
// opt-in via the `strict` parameter.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ---------- Top-level row shapes ----------

export interface BaseEnvelope {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  userType?: string;
  isSidechain?: boolean;
}

export interface AssistantRow extends BaseEnvelope {
  type: "assistant";
  requestId?: string;
  attributionSkill?: string | null;
  message: AssistantMessage;
}

export interface UserRow extends BaseEnvelope {
  type: "user";
  promptId?: string;
  isMeta?: boolean;
  message: UserMessage;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

export interface AttachmentRow extends BaseEnvelope {
  type: "attachment";
  attachment: Attachment;
}

export interface LastPromptRow {
  type: "last-prompt";
  leafUuid: string;
  sessionId: string;
}

export interface QueueOperationRow {
  type: "queue-operation";
  operation: "enqueue" | "dequeue";
  sessionId: string;
  timestamp: string;
  content?: string;
}

export interface SystemRow extends BaseEnvelope {
  type: "system";
  subtype?: string;
  level?: string;
  error?: unknown;
  retryAttempt?: number;
  retryInMs?: number;
  maxRetries?: number;
  stopReason?: string;
  preventedContinuation?: boolean;
  hasOutput?: boolean;
  hookCount?: number;
  hookErrors?: unknown;
  hookInfos?: unknown;
  toolUseID?: string;
}

export interface RawRow {
  type: string;
  [k: string]: unknown;
}

export type SessionRow =
  | AssistantRow
  | UserRow
  | AttachmentRow
  | LastPromptRow
  | QueueOperationRow
  | SystemRow
  | RawRow;

// ---------- Assistant message internals ----------

export interface AssistantMessage {
  id: string;
  model: string;
  role: "assistant";
  type: "message";
  content: ContentBlock[];
  stop_reason?: string;
  stop_details?: unknown;
  stop_sequence?: string | null;
  usage: Usage;
  diagnostics?: Diagnostics | null;
}

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  tool_name?: string;
  content: ContentBlock[] | string;
}

// ---------- Usage ----------

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  iterations?: UsageIteration[];
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
  service_tier?: string;
  speed?: string | null;
  inference_geo?: string;
}

export interface UsageIteration {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  type?: string;
}

export interface Diagnostics {
  cache_miss_reason?: {
    type?: string;
    cache_missed_input_tokens?: number;
  };
}

// ---------- Attachments ----------

export type AttachmentType =
  | "hook_success"
  | "hook_system_message"
  | "hook_additional_context"
  | "skill_listing"
  | "deferred_tools_delta"
  | "todo_reminder"
  | "date_change"
  | "command_permissions"
  | "auto_mode"
  | (string & {}); // future-compatible

export interface Attachment {
  type: AttachmentType;
  content?: string | string[];
  hookName?: string;
  hookEvent?: string;
  toolUseID?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  command?: string;
  skillCount?: number;
  isInitial?: boolean;
  addedNames?: string[];
  addedLines?: string[];
  removedNames?: string[];
  readdedNames?: string[];
  pendingMcpServers?: string[];
  [k: string]: unknown;
}

// ---------- Public API ----------

export interface ParseOptions {
  strict?: boolean;          // throw on parse error vs. emit RawRow
  onError?: (err: Error, line: string, lineNumber: number) => void;
}

export async function parseSession(
  path: string,
  options: ParseOptions = {},
): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  for await (const row of streamSession(path, options)) {
    rows.push(row);
  }
  return rows;
}

export async function* streamSession(
  path: string,
  options: ParseOptions = {},
): AsyncIterable<SessionRow> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as SessionRow;
    } catch (err) {
      if (options.strict) throw err;
      options.onError?.(err as Error, line, lineNumber);
    }
  }
}

// ---------- Discriminators ----------

export const isAssistant = (r: SessionRow): r is AssistantRow => r.type === "assistant";
export const isUser = (r: SessionRow): r is UserRow => r.type === "user";
export const isAttachment = (r: SessionRow): r is AttachmentRow => r.type === "attachment";

// ---------- Aggregation helpers ----------

export interface UsageTotals {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  assistant_turns: number;
}

export function sumUsage(rows: SessionRow[]): UsageTotals {
  const totals: UsageTotals = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    assistant_turns: 0,
  };
  for (const row of rows) {
    if (!isAssistant(row)) continue;
    const u = row.message.usage;
    totals.input_tokens += u.input_tokens ?? 0;
    totals.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    totals.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    totals.output_tokens += u.output_tokens ?? 0;
    totals.assistant_turns++;
  }
  return totals;
}

export function cacheHitRate(t: UsageTotals): number {
  const denom = t.cache_read_input_tokens + t.cache_creation_input_tokens;
  return denom > 0 ? t.cache_read_input_tokens / denom : 0;
}

export interface SkillAttribution {
  skill: string;
  turns: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
}

export function attributeBySkill(rows: SessionRow[]): SkillAttribution[] {
  const map = new Map<string, SkillAttribution>();
  for (const row of rows) {
    if (!isAssistant(row)) continue;
    const skill = row.attributionSkill ?? "<unattributed>";
    const entry = map.get(skill) ?? {
      skill,
      turns: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    entry.turns++;
    entry.output_tokens += row.message.usage.output_tokens ?? 0;
    entry.cache_creation_input_tokens += row.message.usage.cache_creation_input_tokens ?? 0;
    map.set(skill, entry);
  }
  return [...map.values()].sort((a, b) => b.output_tokens - a.output_tokens);
}
