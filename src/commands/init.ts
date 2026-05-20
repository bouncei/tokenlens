import kleur from "kleur";
import {
  defaultConfigForTier,
  saveConfig,
  configExists,
  type Tier,
  TIER_WEEKLY_BUDGETS,
} from "../budget.js";
import { fmtTokens } from "../format.js";

export interface InitOptions {
  tier?: Tier;
  force?: boolean;
  home?: string;
}

const VALID_TIERS = ["pro", "max5", "max20", "api"] as const;

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const tier = opts.tier ?? "max5";
  if (!VALID_TIERS.includes(tier as (typeof VALID_TIERS)[number])) {
    console.error(
      kleur.red(`tokenlens init: --tier must be one of ${VALID_TIERS.join(", ")}`),
    );
    process.exit(1);
  }

  if ((await configExists(opts.home)) && !opts.force) {
    console.error(
      kleur.yellow(
        "tokenlens.json already exists at ~/.claude/tokenlens.json. Pass --force to overwrite.",
      ),
    );
    process.exit(1);
  }

  const config = defaultConfigForTier(tier);
  const path = await saveConfig(config, opts.home);

  console.log("");
  console.log(kleur.bold("tokenlens init"));
  console.log(kleur.dim(`  wrote ${path}`));
  console.log("");
  console.log(
    `  tier               ${kleur.cyan(tier)}`,
  );
  console.log(
    `  weeklyTokenBudget  ${kleur.cyan(fmtTokens(config.weeklyTokenBudget))} ${kleur.dim(`(${config.weeklyTokenBudget.toLocaleString()} tokens)`)}`,
  );
  console.log(
    `  thresholds         ${kleur.cyan(config.warningThresholdPercent + "%")} warn → ${kleur.yellow(config.askThresholdPercent + "%")} ask → ${kleur.red(config.blockThresholdPercent + "%")} block`,
  );
  console.log(
    `  hardCap            ${config.hardCap ? kleur.red("true (block at ask threshold)") : kleur.dim("false (asks before blocking)")}`,
  );
  console.log("");
  console.log(kleur.dim("Tier presets:"));
  for (const t of VALID_TIERS) {
    const marker = t === tier ? kleur.cyan(" ←") : "";
    console.log(
      kleur.dim(
        `  ${t.padEnd(6)} ${fmtTokens(TIER_WEEKLY_BUDGETS[t]).padStart(7)}${marker}`,
      ),
    );
  }
  console.log("");
  console.log(
    kleur.dim(
      "Adjust any field manually in ~/.claude/tokenlens.json. Run `tokenlens init --tier max20 --force` to switch tiers.",
    ),
  );
}
