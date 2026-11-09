import { config } from "./config";

function mask(text: string): string {
  return text.split(config.ENTITY_TOKEN).join("***TOKEN***");
}

function format(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.message;
    return JSON.stringify(a);
  });
  return mask(parts.join(" "));
}

const stamp = () => new Date().toISOString();

export const log = {
  info: (...args: unknown[]) => console.log(`${stamp()} INFO  ${format(args)}`),
  warn: (...args: unknown[]) => console.warn(`${stamp()} WARN  ${format(args)}`),
  error: (...args: unknown[]) => console.error(`${stamp()} ERROR ${format(args)}`),
};