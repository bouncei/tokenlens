#!/usr/bin/env node
import { runStatus } from "./commands/status.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "status":
      await runStatus(parseStatusFlags(args.slice(1)));
      break;
    case "watch":
    case "doctor":
      console.error(`tokenlens: '${command}' is not implemented yet.`);
      process.exit(1);
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

function parseStatusFlags(args: string[]): { cwd?: string; sessionPath?: string } {
  const out: { cwd?: string; sessionPath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cwd") out.cwd = args[++i];
    else if (a === "--session") out.sessionPath = args[++i];
  }
  return out;
}

function printHelp() {
  console.log(`tokenlens — see what's eating your Claude Code context.

Usage:
  tokenlens <command> [flags]

Commands:
  status     Show a breakdown of the current session's token spend by source
  watch      Live-update breakdown as the session changes (not yet implemented)
  doctor     Detect and fix duplicate skills / stale plugin versions (not yet implemented)

Flags (status):
  --cwd <path>       Resolve the active session for a different working directory
  --session <file>   Read a specific .jsonl directly (skips cwd lookup)

This is pre-alpha. See DESIGN.md for the plan.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
