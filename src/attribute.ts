// Attribute observed token spend back to its sources (skills, MCP servers,
// hook-injected context, etc.) using two signals:
//
//   1. attachment.content — the literal text injected by a hook or skill_listing
//   2. cache_creation_input_tokens — Anthropic's own count of what was written
//      to cache on a given turn
//
// For the live session view we use *Anthropic's* numbers wherever possible.
// We only fall back to local tokenization (in tokens/count.ts, not here)
// when no usage row has been emitted yet — i.e. for the pre-flight estimate.

import {
  type AttachmentRow,
  type AssistantRow,
  type SessionRow,
  isAssistant,
  isAttachment,
} from "./parsers/session.js";

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
  index: number;                   // row index in the session
  uuid?: string;
  timestamp?: string;
  category: SourceCategory;
  label: string;                   // e.g. "skill_listing(44 skills)"
  textBytes: number;               // size of injected content (when present)
  toolNamesAdded?: string[];       // for deferred_tools_delta
  pendingMcpServers?: string[];
  followingTurnCacheCreation?: number; // cache_creation_input_tokens on the next assistant turn
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

function attachmentBytes(att: AttachmentRow["attachment"]): number {
  if (typeof att.content === "string") return Buffer.byteLength(att.content);
  if (Array.isArray(att.content)) {
    return att.content.reduce(
      (n, s) => n + (typeof s === "string" ? Buffer.byteLength(s) : 0),
      0,
    );
  }
  return 0;
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

/**
 * Walk the session in order, build a list of attachment injections, and
 * tag each one with a *share* of the cache_creation_input_tokens observed
 * on the immediately-following assistant turn.
 *
 * Share-out: when N attachments precede the same assistant turn, that
 * turn's cache_creation is divided across them proportional to each
 * attachment's content size (falling back to even split when none have
 * content). This avoids the obvious double-count where session-start
 * fires five attachments before the first turn and each one looks
 * "responsible" for the full 22k cache write.
 *
 * It's still a loose attribution — what actually got written to cache may
 * include things outside our visible attachments — but the share-out keeps
 * the totals honest.
 */
export function buildAttachmentEvents(rows: SessionRow[]): AttachmentEvent[] {
  // Group attachments by the index of the assistant turn that follows them.
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
  for (const [followingIdx, attachmentIdxs] of groups) {
    const following = rows[followingIdx] as AssistantRow;
    const followingCC = following.message.usage.cache_creation_input_tokens ?? 0;

    const sizes = attachmentIdxs.map((i) =>
      attachmentBytes((rows[i] as AttachmentRow).attachment),
    );
    const totalSize = sizes.reduce((n, s) => n + s, 0);

    attachmentIdxs.forEach((i, k) => {
      const row = rows[i] as AttachmentRow;
      const att = row.attachment;
      const share =
        totalSize > 0
          ? Math.round(followingCC * (sizes[k] / totalSize))
          : Math.round(followingCC / attachmentIdxs.length);

      events.push({
        index: i,
        uuid: row.uuid,
        timestamp: row.timestamp,
        category: categorizeAttachment(att),
        label: attachmentLabel(att),
        textBytes: sizes[k],
        toolNamesAdded: att.type === "deferred_tools_delta" ? att.addedNames : undefined,
        pendingMcpServers: att.pendingMcpServers,
        followingTurnCacheCreation: share,
      });
    });
  }

  // Add tail attachments with no following assistant turn (rare; usually
  // session-end). They get 0 attribution.
  for (let i = 0; i < rows.length; i++) {
    if (!isAttachment(rows[i])) continue;
    if ((nextAssistantIndex.get(i) ?? -1) < 0) {
      const row = rows[i] as AttachmentRow;
      const att = row.attachment;
      events.push({
        index: i,
        uuid: row.uuid,
        timestamp: row.timestamp,
        category: categorizeAttachment(att),
        label: attachmentLabel(att),
        textBytes: attachmentBytes(att),
        toolNamesAdded: att.type === "deferred_tools_delta" ? att.addedNames : undefined,
        pendingMcpServers: att.pendingMcpServers,
        followingTurnCacheCreation: 0,
      });
    }
  }

  return events.sort((a, b) => a.index - b.index);
}

export interface CategoryTotal {
  category: SourceCategory;
  events: number;
  textBytes: number;
  // Sum of cache_creation_input_tokens on the assistant turn that
  // *immediately followed* events in this category. Loose attribution.
  followingCacheCreation: number;
}

export function totalsByCategory(events: AttachmentEvent[]): CategoryTotal[] {
  const map = new Map<SourceCategory, CategoryTotal>();
  for (const ev of events) {
    const entry = map.get(ev.category) ?? {
      category: ev.category,
      events: 0,
      textBytes: 0,
      followingCacheCreation: 0,
    };
    entry.events++;
    entry.textBytes += ev.textBytes;
    entry.followingCacheCreation += ev.followingTurnCacheCreation ?? 0;
    map.set(ev.category, entry);
  }
  return [...map.values()].sort((a, b) => b.followingCacheCreation - a.followingCacheCreation);
}
