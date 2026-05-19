import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export interface ClaudePaths {
  root: string;
  projects: string;
  sessions: string;
  plugins: string;
  skills: string;
  settings: string;
}

export function claudePaths(home: string = homedir()): ClaudePaths {
  const root = join(home, ".claude");
  return {
    root,
    projects: join(root, "projects"),
    sessions: join(root, "sessions"),
    plugins: join(root, "plugins"),
    skills: join(root, "skills"),
    settings: join(root, "settings.json"),
  };
}

/**
 * Encode an absolute filesystem path the same way Claude Code does to
 * locate the per-project session directory.
 *
 * Rule: split on "/", replace "." with "-" in each segment, join with "-".
 * A leading "/" produces a leading "-".
 */
export function encodeProjectDir(absPath: string): string {
  const segments = absPath.split("/");
  return segments.map((s) => s.replaceAll(".", "-")).join("-");
}

export interface SessionFile {
  path: string;
  uuid: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * List session jsonl files for a given cwd, newest first by mtime.
 */
export async function listSessionsForCwd(
  cwd: string,
  paths: ClaudePaths = claudePaths(),
): Promise<SessionFile[]> {
  const dir = join(paths.projects, encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const sessions: SessionFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const fullPath = join(dir, name);
    try {
      const stat = await fs.stat(fullPath);
      sessions.push({
        path: fullPath,
        uuid: basename(name, ".jsonl"),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch {
      // skip
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Best-effort guess of the active session for a cwd: the most recently
 * modified jsonl. (Better: read ~/.claude/sessions/ for an explicit pointer
 * — to be implemented when we know that file's schema.)
 */
export async function findActiveSession(
  cwd: string,
  paths: ClaudePaths = claudePaths(),
): Promise<SessionFile | undefined> {
  const sessions = await listSessionsForCwd(cwd, paths);
  return sessions[0];
}
