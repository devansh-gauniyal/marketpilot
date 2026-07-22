// Scanner parser sanity test. This does not call GitHub; it verifies the
// source parser finds missing/empty alt text and ignores complete image tags.
//
// Run with: npx tsx src/lib/tools/seo/__tests__/scan-alt-text-gaps.test.ts

import { findMissingAltText } from "../../../connectors/github/mdx";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

const sample = [
  "# Demo page",
  "",
  '<img src="/assets/missing.svg" />',
  '<img src="/assets/empty.svg" alt="" />',
  '<img src="/assets/good.svg" alt="Useful description" />',
  '<img alt="Alt before src also works" src="/assets/good-2.svg" />',
].join("\n");

const gaps = findMissingAltText(sample, "content/pages/demo.mdx");

assert(gaps.length === 2, "finds missing and empty alt only");
assert(gaps[0].filepath === "content/pages/demo.mdx", "includes filepath");
assert(gaps[0].imageSrc === "/assets/missing.svg", "reads missing-alt image src");
assert(gaps[0].line === 3, "includes source line number");
assert(gaps[1].imageSrc === "/assets/empty.svg", "reads empty-alt image src");

console.log("\nAll scan_alt_text_gaps parser tests passed.");
