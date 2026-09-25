#!/usr/bin/env node
// Set "admins" on one or more control.json files. Usage:
//   node set-admins.mjs <file.json>... -- alias1 alias2
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const sep = args.indexOf("--");
const files = args.slice(0, sep), admins = args.slice(sep + 1).map((a) => a.trim().toLowerCase()).filter(Boolean);
for (const f of files) {
  const doc = JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, "")); // strip a BOM if an editor added one
  doc.admins = admins;
  writeFileSync(f, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${f}: admins = [${admins.join(", ")}]`);
}
