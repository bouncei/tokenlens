import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/commands/doctor.js";

// Build a fake ~/.claude tree with known pathologies, then exercise doctor
// in dry-run and --fix modes against it.

interface FakeHome {
  home: string;
  cleanup: () => Promise<void>;
}

async function buildFakeHome(): Promise<FakeHome> {
  const home = await fs.mkdtemp(join(tmpdir(), "tokenlens-test-"));
  const claude = join(home, ".claude");

  await fs.mkdir(join(claude, "plugins", "cache", "claude-plugins-official", "foo", "1.2.3"), { recursive: true });
  await fs.mkdir(join(claude, "plugins", "cache", "claude-plugins-official", "foo", "1.2.2"), { recursive: true });
  await fs.mkdir(join(claude, "plugins", "cache", "claude-plugins-official", "bar", "0.5.0"), { recursive: true });
  await fs.writeFile(
    join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "foo@claude-plugins-official": [{ version: "1.2.3" }],
        "bar@claude-plugins-official": [{ version: "0.5.0" }],
      },
    }),
  );

  // Skills dir with one canonical file and two symlinks → same target.
  const skillsDir = join(claude, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  const realSkill = join(home, "real-skill.md");
  await fs.writeFile(realSkill, "# real skill");
  await fs.symlink(realSkill, join(skillsDir, "alpha.md"));
  await fs.symlink(realSkill, join(skillsDir, "beta.md"));      // duplicate
  await fs.symlink(realSkill, join(skillsDir, "gamma.md"));     // duplicate

  return {
    home,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

describe("doctor", () => {
  let env: FakeHome;
  let logged: string[];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    env = await buildFakeHome();
    logged = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = originalLog;
    await env.cleanup();
  });

  it("detects stale plugin versions in dry-run", async () => {
    await runDoctor({ home: env.home });
    const out = logged.join("\n");
    expect(out).toContain("foo");
    expect(out).toContain("1.2.2");
    expect(out).toContain("1.2.3");
    // bar has only one version → not stale.
    expect(out).not.toContain("bar:");
  });

  it("detects duplicate skill symlinks in dry-run", async () => {
    await runDoctor({ home: env.home });
    const out = logged.join("\n");
    expect(out).toMatch(/beta\.md|gamma\.md/);
  });

  it("does not delete in dry-run", async () => {
    await runDoctor({ home: env.home });
    const stale = join(env.home, ".claude", "plugins", "cache", "claude-plugins-official", "foo", "1.2.2");
    const beta = join(env.home, ".claude", "skills", "beta.md");
    await expect(fs.access(stale)).resolves.toBeUndefined();
    await expect(fs.lstat(beta)).resolves.toBeDefined();
  });

  it("deletes when --fix is set", async () => {
    await runDoctor({ home: env.home, fix: true });
    const stale = join(env.home, ".claude", "plugins", "cache", "claude-plugins-official", "foo", "1.2.2");
    const active = join(env.home, ".claude", "plugins", "cache", "claude-plugins-official", "foo", "1.2.3");
    const beta = join(env.home, ".claude", "skills", "beta.md");
    const alpha = join(env.home, ".claude", "skills", "alpha.md");
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(active)).resolves.toBeUndefined();   // active untouched
    await expect(fs.lstat(beta)).rejects.toThrow();
    await expect(fs.lstat(alpha)).resolves.toBeDefined();       // first symlink kept
  });
});
