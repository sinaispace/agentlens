/** Colour only on a TTY that hasn't opted out via NO_COLOR. */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = wrap("1");
export const dim = wrap("2");
const green = wrap("32");
const yellow = wrap("33");
const red = wrap("31");

export function ok(message: string): void {
  console.log(`${green("✔")} ${message}`);
}

export function warn(message: string): void {
  console.log(`${yellow("!")} ${message}`);
}

export function fail(message: string): void {
  console.error(`${red("✖")} ${message}`);
}

export function arrow(message: string): void {
  console.log(`${green("→")} ${message}`);
}
