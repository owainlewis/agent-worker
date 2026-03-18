const esc = (code: string) => `\x1b[${code}m`;
const reset = esc("0");

export const colors = {
  bold: (s: string) => `${esc("1")}${s}${reset}`,
  dim: (s: string) => `${esc("2")}${s}${reset}`,
  red: (s: string) => `${esc("31")}${s}${reset}`,
  green: (s: string) => `${esc("32")}${s}${reset}`,
  yellow: (s: string) => `${esc("33")}${s}${reset}`,
  blue: (s: string) => `${esc("34")}${s}${reset}`,
  cyan: (s: string) => `${esc("36")}${s}${reset}`,
  gray: (s: string) => `${esc("90")}${s}${reset}`,
};

export const isTTY = process.stdout.isTTY === true;

export function printSplash(version: string): void {
  if (!isTTY) return;

  const title = `Agent Worker  v${version}`;
  const subtitle = "Linear → Claude Code pipeline";
  const width = Math.max(title.length, subtitle.length) + 4;

  const top = `  ╔${"═".repeat(width)}╗`;
  const bot = `  ╚${"═".repeat(width)}╝`;
  const pad = (text: string, visibleLen: number) =>
    `  ║  ${text}${" ".repeat(width - visibleLen - 2)}║`;

  console.log("");
  console.log(colors.cyan(top));
  console.log(colors.cyan(pad(`${esc("1")}${title}${esc("22")}`, title.length)));
  console.log(colors.cyan(pad(subtitle, subtitle.length)));
  console.log(colors.cyan(bot));
  console.log("");
}

const levelColors: Record<string, (s: string) => string> = {
  debug: colors.gray,
  info: colors.blue,
  warn: colors.yellow,
  error: colors.red,
};

export function formatConsoleLine(
  level: string,
  msg: string,
  ctx?: Record<string, unknown>
): string {
  const time = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Special case: bare Claude output lines
  if (msg === "claude" && ctx?.line !== undefined) {
    return `  ${colors.dim("│")} ${ctx.line}`;
  }

  const colorFn = levelColors[level] ?? colors.gray;
  const badge = colorFn(level.toUpperCase().padEnd(5));

  let ctxStr = "";
  if (ctx && Object.keys(ctx).length > 0) {
    ctxStr =
      " " +
      colors.dim(
        Object.entries(ctx)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      );
  }

  return `${colors.dim(time)}  ${badge}  ${msg}${ctxStr}`;
}
