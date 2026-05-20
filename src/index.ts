#!/usr/bin/env node
import { runStatus } from "./commands/status.js";
import { runWatch } from "./commands/watch.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runBudget } from "./commands/budget.js";
import type { Tier } from "./budget.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "status":
      await runStatus(parseStatusFlags(args.slice(1)));
      break;
    case "watch":
      await runWatch(parseCommonFlags(args.slice(1)));
      break;
    case "doctor":
      await runDoctor(parseDoctorFlags(args.slice(1)));
      break;
    case "init":
      await runInit(parseInitFlags(args.slice(1)));
      break;
    case "budget":
      await runBudget(parseCommonFlags(args.slice(1)));
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`tokenlens: unknown command '${command}'.`);
      printHelp();
      process.exit(1);
  }
}

function parseCommonFlags(args: string[]): { cwd?: string; sessionPath?: string } {
  const out: { cwd?: string; sessionPath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cwd") out.cwd = args[++i];
    else if (a === "--session") out.sessionPath = args[++i];
  }
  return out;
}

function parseStatusFlags(args: string[]): {
  cwd?: string;
  sessionPath?: string;
  showDead?: boolean;
} {
  const out = parseCommonFlags(args) as {
    cwd?: string;
    sessionPath?: string;
    showDead?: boolean;
  };
  out.showDead = args.includes("--show-dead");
  return out;
}

function parseDoctorFlags(args: string[]): { fix?: boolean } {
  return { fix: args.includes("--fix") };
}

function parseInitFlags(args: string[]): { tier?: Tier; force?: boolean } {
  const out: { tier?: Tier; force?: boolean } = { force: args.includes("--force") };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") {
      const t = args[++i];
      if (t === "pro" || t === "max5" || t === "max20" || t === "api") out.tier = t;
    }
  }
  return out;
}

function printHelp() {
  console.log(`tokenlens — see what's eating your Claude Code context.

Usage:
  tokenlens <command> [flags]

Commands:
  status     Show a breakdown of the current session's token spend by source
  watch      Live-update breakdown as the active session grows (ctrl-c to stop)
  doctor     Detect (and optionally fix) duplicate skills / stale plugin versions
  init       Write a default tokenlens.json config (v2 setup; prep for plugin)
  budget     Show your current session vs. weekly budget (preview of v2 hook)

Flags (status, watch):
  --cwd <path>       Resolve the active session for a different working directory
  --session <file>   Read a specific .jsonl directly (skips cwd lookup)

Flags (status only):
  --show-dead        List every dead MCP tool by name, grouped by server

Flags (doctor):
  --fix              Actually delete stale items (default is dry-run)

Flags (init):
  --tier <pro|max5|max20|api>  Preset weekly budget (default: max5)
  --force                       Overwrite existing tokenlens.json

This is pre-alpha. See DESIGN.md for the plan.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
