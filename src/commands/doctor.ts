// `tokenlens doctor` — detect (and optionally fix) the context-bloat
// pathologies documented in anthropics/claude-code Issue #29971:
//
//   1. Stale plugin versions: ~/.claude/plugins/cache/<source>/<plugin>/<version>
//      contains directories for inactive versions still being injected.
//   2. Duplicate skill symlinks: ~/.claude/skills/ has multiple symlinks
//      pointing to the same canonical skill, causing 2x injection.
//
// Default: report only (dry-run). Pass --fix to actually delete.
//
// Safety:
//   - Every deletion is logged with full path.
//   - All paths are sanity-checked to be under ~/.claude/ before unlinking.
//   - No --force flag exists; if the data is unexpected, we bail loud.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import kleur from "kleur";
import { claudePaths } from "../claude-state.js";

export interface DoctorOptions {
  fix?: boolean;
  home?: string;
}

interface InstalledPlugins {
  plugins?: Record<string, Array<{ version: string }>>;
}

interface StalePluginVersion {
  pluginName: string;
  source: string;            // e.g. "claude-plugins-official"
  activeVersion: string;
  staleVersion: string;
  path: string;
}

interface DuplicateSkillSymlink {
  symlinkPath: string;
  targetPath: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const paths = claudePaths(home);
  const claudeRoot = paths.root;

  console.log(kleur.bold("tokenlens doctor"));
  console.log(kleur.dim(`  ~/.claude → ${claudeRoot}`));
  console.log(kleur.dim(`  mode: ${opts.fix ? kleur.yellow("FIX") : kleur.cyan("dry-run")} (pass --fix to apply)`));
  console.log("");

  const staleVersions = await findStalePluginVersions(paths.plugins).catch((err) => {
    console.log(kleur.dim(`  (skipping plugin cache: ${(err as Error).message})`));
    return [] as StalePluginVersion[];
  });

  const dupSymlinks = await findDuplicateSkillSymlinks(paths.skills).catch((err) => {
    console.log(kleur.dim(`  (skipping skills: ${(err as Error).message})`));
    return [] as DuplicateSkillSymlink[];
  });

  // ----- Report -----
  console.log(kleur.bold("Stale plugin versions"));
  if (staleVersions.length === 0) {
    console.log(kleur.green("  ✓ none found"));
  } else {
    for (const s of staleVersions) {
      console.log(
        "  " +
          kleur.yellow("●") +
          ` ${s.pluginName}: keep ${kleur.green(s.activeVersion)}, drop ${kleur.red(s.staleVersion)}`,
      );
      console.log(kleur.dim(`      ${s.path}`));
    }
  }
  console.log("");

  console.log(kleur.bold("Duplicate skill symlinks"));
  if (dupSymlinks.length === 0) {
    console.log(kleur.green("  ✓ none found"));
  } else {
    for (const d of dupSymlinks) {
      console.log("  " + kleur.yellow("●") + ` ${d.symlinkPath}`);
      console.log(kleur.dim(`      → ${d.targetPath}`));
    }
  }
  console.log("");

  if (!opts.fix) {
    if (staleVersions.length === 0 && dupSymlinks.length === 0) {
      console.log(kleur.dim("Nothing to do."));
    } else {
      console.log(kleur.dim("Re-run with --fix to apply."));
    }
    return;
  }

  // ----- Apply -----
  let deleted = 0;
  for (const s of staleVersions) {
    assertUnderClaudeRoot(s.path, claudeRoot);
    process.stdout.write(`  rm -rf ${s.path} ... `);
    await fs.rm(s.path, { recursive: true, force: true });
    deleted++;
    console.log(kleur.green("done"));
  }
  for (const d of dupSymlinks) {
    assertUnderClaudeRoot(d.symlinkPath, claudeRoot);
    process.stdout.write(`  unlink ${d.symlinkPath} ... `);
    await fs.unlink(d.symlinkPath);
    deleted++;
    console.log(kleur.green("done"));
  }
  console.log("");
  console.log(kleur.green(`Removed ${deleted} item${deleted === 1 ? "" : "s"}.`));
}

function assertUnderClaudeRoot(path: string, root: string) {
  const r = resolve(path);
  const c = resolve(root);
  if (!r.startsWith(c + sep) && r !== c) {
    throw new Error(`Refusing to delete path outside ~/.claude: ${path}`);
  }
}

/**
 * Walk ~/.claude/plugins/cache/<source>/<plugin>/ and detect plugin
 * directories with more than one version subdir. The "active" version is
 * read from ~/.claude/plugins/installed_plugins.json.
 *
 * Layout (per Issue #29971):
 *   ~/.claude/plugins/
 *     installed_plugins.json
 *     cache/
 *       claude-plugins-official/
 *         some-plugin/
 *           1.2.3/       ← active
 *           1.2.2/       ← stale (still injected!)
 */
async function findStalePluginVersions(pluginsRoot: string): Promise<StalePluginVersion[]> {
  const out: StalePluginVersion[] = [];
  const manifestPath = join(pluginsRoot, "installed_plugins.json");

  let manifest: InstalledPlugins;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const active = new Map<string, string>();
  for (const [fullName, installs] of Object.entries(manifest.plugins ?? {})) {
    const plugin = fullName.split("@")[0]!;
    const ver = installs?.[0]?.version;
    if (ver) active.set(plugin, ver);
  }

  const cacheRoot = join(pluginsRoot, "cache");
  let sources: string[];
  try {
    sources = await fs.readdir(cacheRoot);
  } catch {
    return [];
  }

  for (const source of sources) {
    const sourceDir = join(cacheRoot, source);
    const sourceStat = await fs.stat(sourceDir).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;

    let plugins: string[];
    try {
      plugins = await fs.readdir(sourceDir);
    } catch {
      continue;
    }

    for (const plugin of plugins) {
      const pluginDir = join(sourceDir, plugin);
      const pluginStat = await fs.stat(pluginDir).catch(() => null);
      if (!pluginStat?.isDirectory()) continue;

      let versions: string[];
      try {
        versions = await fs.readdir(pluginDir);
      } catch {
        continue;
      }
      const versionDirs = await filterDirs(pluginDir, versions);

      const activeVersion = active.get(plugin);
      if (!activeVersion) continue; // unknown active → bail rather than guess
      if (versionDirs.length <= 1) continue;

      for (const v of versionDirs) {
        if (v === activeVersion) continue;
        out.push({
          pluginName: plugin,
          source,
          activeVersion,
          staleVersion: v,
          path: join(pluginDir, v),
        });
      }
    }
  }
  return out;
}

async function filterDirs(parent: string, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const stat = await fs.stat(join(parent, name)).catch(() => null);
    if (stat?.isDirectory()) out.push(name);
  }
  return out;
}

/**
 * Walk ~/.claude/skills/ and find symlinks whose canonical target appears
 * more than once. We report all but the first occurrence as duplicates.
 */
async function findDuplicateSkillSymlinks(skillsRoot: string): Promise<DuplicateSkillSymlink[]> {
  let names: string[];
  try {
    names = await fs.readdir(skillsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const seen = new Map<string, string>();    // target → first symlinkPath
  const dups: DuplicateSkillSymlink[] = [];

  for (const name of names) {
    const symlinkPath = join(skillsRoot, name);
    let lstat;
    try {
      lstat = await fs.lstat(symlinkPath);
    } catch {
      continue;
    }
    if (!lstat.isSymbolicLink()) continue;

    let target: string;
    try {
      target = await fs.realpath(symlinkPath);
    } catch {
      continue;
    }

    if (seen.has(target)) {
      dups.push({ symlinkPath, targetPath: target });
    } else {
      seen.set(target, symlinkPath);
    }
  }
  return dups;
}
