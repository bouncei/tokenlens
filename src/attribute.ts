// Attribute observed token spend back to its sources (skills, MCP servers,
// hook-injected context, etc.) using two signals:
//
//   1. attachment payload — the literal text injected by a hook or
//      skill_listing (counted with the local tokenizer)
//   2. cache_creation_input_tokens — Anthropic's own count of what was
//      written to cache on a given turn
//
// Strategy (v1): per-following-turn share-out.
//
//   For each assistant turn, gather all attachments injected since the
//   previous turn. Assign each attachment a *weight*:
//     - text-bearing → estimated tokens of its content
//     - deferred_tools_delta → 250 * tools_added (heuristic)
//     - other text-less attachments → 50 (heuristic)
//   Then allocate the turn's observed cache_creation_input_tokens across
//   the attachments in proportion to weight. This gives non-zero credit
//   to MCP loading even though we can't see the tool schemas locally.
//
// This is still a loose attribution — Anthropic's cache_creation can
// include things outside our visible attachments (e.g., file reads
// promoted into context, cache TTL invalidation). We mark heuristic
// values in the UI so the user knows what's a count vs. an estimate.

import {
  type AttachmentRow,
  type AssistantRow,
  type SessionRow,
  isAssistant,
  isAttachment,
} from "./parsers/session.js";
import {
  estimateTextTokens,
  TOOL_DEFINITION_TOKEN_ESTIMATE,
  STRUCTURAL_ATTACHMENT_TOKEN_ESTIMATE,
} from "./tokens/count.js";

export type SourceCategory =
  | "skill_listing"
  | "hook_additional_context"
  | "deferred_tools_added"
  | "todo_reminder"
  | "hook_system_message"
  | "hook_success"
  | "date_change"
  | "command_permissions"
  | "auto_mode"
  | "other";

export interface AttachmentEvent {
  index: number;
  uuid?: string;
  timestamp?: string;
  category: SourceCategory;
  label: string;
  textBytes: number;
  estimatedTokens: number;        // local estimate (heuristic for text-less)
  isEstimated: boolean;           // true when no text payload was tokenized
  toolNamesAdded?: string[];
  pendingMcpServers?: string[];
  /** Allocated share of the next assistant turn's cache_creation_input_tokens. */
  attributedCacheCreation: number;
}

const KNOWN_CATEGORIES = new Set<string>([
  "skill_listing",
  "hook_additional_context",
  "todo_reminder",
  "hook_system_message",
  "hook_success",
  "date_change",
  "command_permissions",
  "auto_mode",
]);

export function categorizeAttachment(att: AttachmentRow["attachment"]): SourceCategory {
  if (att.type === "deferred_tools_delta") return "deferred_tools_added";
  if (typeof att.type === "string" && KNOWN_CATEGORIES.has(att.type)) {
    return att.type as SourceCategory;
  }
  return "other";
}

function attachmentText(att: AttachmentRow["attachment"]): string {
  if (typeof att.content === "string") return att.content;
  if (Array.isArray(att.content)) {
    return att.content
      .filter((s): s is string => typeof s === "string")
      .join("\n");
  }
  return "";
}

function attachmentBytes(att: AttachmentRow["attachment"]): number {
  return Buffer.byteLength(attachmentText(att));
}

function attachmentLabel(att: AttachmentRow["attachment"]): string {
  if (att.type === "skill_listing" && typeof att.skillCount === "number") {
    return `skill_listing(${att.skillCount} skills)`;
  }
  if (att.type === "deferred_tools_delta") {
    const added = att.addedNames?.length ?? 0;
    const removed = att.removedNames?.length ?? 0;
    const pending = att.pendingMcpServers?.length ?? 0;
    const parts: string[] = [];
    if (added) parts.push(`+${added}`);
    if (removed) parts.push(`-${removed}`);
    if (pending) parts.push(`pending mcp: ${att.pendingMcpServers!.join(",")}`);
    return `deferred_tools_delta(${parts.join(" ")})`;
  }
  if (att.type === "hook_additional_context" && att.hookName) {
    return `hook_additional_context(${att.hookName})`;
  }
  return att.type ?? "unknown";
}

interface Weighted {
  weight: number;
  isEstimated: boolean;
}

function weighAttachment(att: AttachmentRow["attachment"]): Weighted {
  const text = attachmentText(att);
  if (text.length > 0) {
    return { weight: estimateTextTokens(text), isEstimated: false };
  }
  if (att.type === "deferred_tools_delta") {
    const tools = att.addedNames?.length ?? 0;
    return {
      weight: tools * TOOL_DEFINITION_TOKEN_ESTIMATE,
      isEstimated: true,
    };
  }
  return { weight: STRUCTURAL_ATTACHMENT_TOKEN_ESTIMATE, isEstimated: true };
}

/**
 * Per-attachment attribution is capped at the attachment's own estimated
 * weight (×CAP_MULTIPLIER for safety margin). Any residual on a turn —
 * cache_creation we can't reasonably explain from visible attachments —
 * is bucketed into a synthetic `cache_invalidation_or_growth` event so it
 * doesn't get pinned on whatever happened to precede it.
 */
const CAP_MULTIPLIER = 1.5;

export interface AttributionResult {
  events: AttachmentEvent[];
  /** Cache_creation that couldn't be tied to any visible attachment. */
  unattributedCacheCreation: number;
  /** Number of assistant turns where unattributed > 0. */
  invalidationTurns: number;
}

/**
 * Walk the session in order, group attachments by the assistant turn that
 * immediately follows them, share-out by estimated weight up to a per-event
 * cap, and surface any unaccountable residual as a separate bucket.
 */
export function buildAttribution(rows: SessionRow[]): AttributionResult {
  const groups = new Map<number, number[]>();
  const nextAssistantIndex = new Map<number, number>();

  for (let i = 0; i < rows.length; i++) {
    if (!isAttachment(rows[i])) continue;
    let nextIdx = -1;
    for (let j = i + 1; j < rows.length; j++) {
      if (isAssistant(rows[j])) {
        nextIdx = j;
        break;
      }
    }
    nextAssistantIndex.set(i, nextIdx);
    if (nextIdx >= 0) {
      const arr = groups.get(nextIdx) ?? [];
      arr.push(i);
      groups.set(nextIdx, arr);
    }
  }

  const events: AttachmentEvent[] = [];
  let unattributed = 0;
  let invalidationTurns = 0;

  for (const [followingIdx, attachmentIdxs] of groups) {
    const following = rows[followingIdx] as AssistantRow;
    const followingCC = following.message.usage.cache_creation_input_tokens ?? 0;

    const weights = attachmentIdxs.map((i) =>
      weighAttachment((rows[i] as AttachmentRow).attachment),
    );
    const totalWeight = weights.reduce((n, w) => n + w.weight, 0);
    const totalCap = Math.round(totalWeight * CAP_MULTIPLIER);

    // We can't credit more than the cap; anything beyond is invalidation.
    const attributable = Math.min(followingCC, totalCap);
    const residual = followingCC - attributable;
    if (residual > 0) {
      unattributed += residual;
      invalidationTurns++;
    }

    attachmentIdxs.forEach((i, k) => {
      const row = rows[i] as AttachmentRow;
      const att = row.attachment;
      const share =
        totalWeight > 0
          ? Math.round(attributable * (weights[k].weight / totalWeight))
          : Math.round(attributable / attachmentIdxs.length);

      events.push({
        index: i,
        uuid: row.uuid,
        timestamp: row.timestamp,
        category: categorizeAttachment(att),
        label: attachmentLabel(att),
        textBytes: attachmentBytes(att),
        estimatedTokens: weights[k].weight,
        isEstimated: weights[k].isEstimated,
        toolNamesAdded: att.type === "deferred_tools_delta" ? att.addedNames : undefined,
        pendingMcpServers: att.pendingMcpServers,
        attributedCacheCreation: share,
      });
    });
  }

  // Tail attachments with no following assistant turn.
  for (let i = 0; i < rows.length; i++) {
    if (!isAttachment(rows[i])) continue;
    if ((nextAssistantIndex.get(i) ?? -1) < 0) {
      const row = rows[i] as AttachmentRow;
      const att = row.attachment;
      const w = weighAttachment(att);
      events.push({
        index: i,
        uuid: row.uuid,
        timestamp: row.timestamp,
        category: categorizeAttachment(att),
        label: attachmentLabel(att),
        textBytes: attachmentBytes(att),
        estimatedTokens: w.weight,
        isEstimated: w.isEstimated,
        toolNamesAdded: att.type === "deferred_tools_delta" ? att.addedNames : undefined,
        pendingMcpServers: att.pendingMcpServers,
        attributedCacheCreation: 0,
      });
    }
  }

  return {
    events: events.sort((a, b) => a.index - b.index),
    unattributedCacheCreation: unattributed,
    invalidationTurns,
  };
}

// Backwards-compat wrapper for tests; thin shim around buildAttribution.
export function buildAttachmentEvents(rows: SessionRow[]): AttachmentEvent[] {
  return buildAttribution(rows).events;
}

export interface CategoryTotal {
  category: SourceCategory;
  events: number;
  textBytes: number;
  estimatedTokens: number;
  attributedCacheCreation: number;
  anyEstimated: boolean;
}

export function totalsByCategory(events: AttachmentEvent[]): CategoryTotal[] {
  const map = new Map<SourceCategory, CategoryTotal>();
  for (const ev of events) {
    const entry = map.get(ev.category) ?? {
      category: ev.category,
      events: 0,
      textBytes: 0,
      estimatedTokens: 0,
      attributedCacheCreation: 0,
      anyEstimated: false,
    };
    entry.events++;
    entry.textBytes += ev.textBytes;
    entry.estimatedTokens += ev.estimatedTokens;
    entry.attributedCacheCreation += ev.attributedCacheCreation;
    entry.anyEstimated = entry.anyEstimated || ev.isEstimated;
    map.set(ev.category, entry);
  }
  return [...map.values()].sort(
    (a, b) => b.attributedCacheCreation - a.attributedCacheCreation,
  );
}
