import { readFileSync, writeFileSync } from "node:fs";

const [input, output, countArg] = process.argv.slice(2);
if (!input || !output || !countArg) {
  console.error("Usage: npx tsx src/scripts/trimFixture.ts <input> <output> <number of lines>");
  process.exit(1);
}

const count = Number(countArg);
const lines = readFileSync(input, "utf8").split("\n").filter(Boolean);
console.log(`Input has ${lines.length} lines`);

const kept = lines.slice(0, count);
writeFileSync(output, kept.join("\n") + "\n");
console.log(`Wrote ${kept.length} lines to ${output}`);