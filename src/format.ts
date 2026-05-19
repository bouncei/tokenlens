import kleur from "kleur";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

export function fmtPct(p: number): string {
  return (p * 100).toFixed(1) + "%";
}

export function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return " ".repeat(width);
  const filled = Math.round((value / max) * width);
  return kleur.cyan("█".repeat(Math.max(0, Math.min(width, filled)))) +
    kleur.dim("░".repeat(Math.max(0, width - filled)));
}

export function rightPad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function leftPad(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}
