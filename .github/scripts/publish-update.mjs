#!/usr/bin/env node
/**
 * Publish a signed .xpi into the `updates` branch checkout and regenerate the
 * Firefox update manifest for that add-on.
 *
 *   node publish-update.mjs <slug> <source-dir> <signed.xpi> <updates-checkout-dir>
 *
 *   slug          folder name under the updates branch (lobby-sweeper | ms-viewer)
 *   source-dir    extension source (read manifest.json for id + version)
 *   signed.xpi    the file web-ext sign produced
 *   updates dir   working copy of the `updates` branch
 *
 * Layout produced (served raw from GitHub):
 *   <slug>/updates.json
 *   <slug>/<slug>-<version>.xpi
 *
 * updates.json format: https://extensionworkshop.com/documentation/manage/updating-your-extension/
 * We keep the last 10 versions listed so Firefox can always step forward.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [slug, sourceDir, xpiPath, updatesDir] = process.argv.slice(2);
if (!slug || !sourceDir || !xpiPath || !updatesDir) {
  console.error("usage: publish-update.mjs <slug> <source-dir> <signed.xpi> <updates-checkout-dir>");
  process.exit(2);
}

const REPO_RAW = "https://raw.githubusercontent.com/sparrrow1011/LTL_Viewer/updates";
const KEEP = 10;

const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
const id = manifest.browser_specific_settings.gecko.id;
const version = manifest.version;
const minVersion = manifest.browser_specific_settings.gecko.strict_min_version;

const outDir = join(updatesDir, slug);
mkdirSync(outDir, { recursive: true });

const xpiName = `${slug}-${version}.xpi`;
copyFileSync(xpiPath, join(outDir, xpiName));

const updatesPath = join(outDir, "updates.json");
const doc = existsSync(updatesPath) ? JSON.parse(readFileSync(updatesPath, "utf8")) : { addons: {} };
const entry = (doc.addons[id] ||= { updates: [] });
entry.updates = entry.updates.filter((u) => u.version !== version);
entry.updates.push({
  version,
  update_link: `${REPO_RAW}/${slug}/${xpiName}`,
  ...(minVersion ? { applications: { gecko: { strict_min_version: minVersion } } } : {}),
});
// Sort by version (numeric dotted compare), keep the newest KEEP.
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};
entry.updates.sort((a, b) => cmp(a.version, b.version));
const dropped = entry.updates.splice(0, Math.max(0, entry.updates.length - KEEP));
for (const d of dropped) {
  const f = join(outDir, `${slug}-${d.version}.xpi`);
  if (existsSync(f)) unlinkSync(f);
}
// Remove stray .xpi files not referenced anymore.
const referenced = new Set(entry.updates.map((u) => u.update_link.split("/").pop()));
for (const f of readdirSync(outDir)) if (f.endsWith(".xpi") && !referenced.has(f)) unlinkSync(join(outDir, f));

writeFileSync(updatesPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`published ${id} ${version} → ${slug}/${xpiName}; ${entry.updates.length} version(s) listed`);
