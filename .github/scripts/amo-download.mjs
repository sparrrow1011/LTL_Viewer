#!/usr/bin/env node
/**
 * Download the already-signed .xpi for the manifest's version from AMO.
 * Used when `web-ext sign` reports the version already exists (someone signed
 * it manually before CI ran). Auth: same JWT scheme web-ext uses.
 *
 *   node amo-download.mjs <source-dir> <out-dir>
 *   env: WEB_EXT_API_KEY, WEB_EXT_API_SECRET
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const [sourceDir, outDir] = process.argv.slice(2);
const key = process.env.WEB_EXT_API_KEY;
const secret = process.env.WEB_EXT_API_SECRET;
if (!sourceDir || !outDir || !key || !secret) {
  console.error("usage: amo-download.mjs <source-dir> <out-dir> (needs WEB_EXT_API_KEY/SECRET)");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
const id = manifest.browser_specific_settings.gecko.id;
const version = manifest.version;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ iss: key, jti: Math.random().toString(36).slice(2), iat: now, exp: now + 300 });
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
const api = (path) => fetch(`https://addons.mozilla.org/api/v5${path}`, { headers: { Authorization: `JWT ${jwt()}` } });

const vr = await api(`/addons/addon/${encodeURIComponent(id)}/versions/?filter=all_with_unlisted`);
if (!vr.ok) throw new Error(`AMO versions lookup HTTP ${vr.status}: ${(await vr.text()).slice(0, 300)}`);
const versions = (await vr.json()).results || [];
const v = versions.find((x) => x.version === version);
if (!v) throw new Error(`version ${version} not found on AMO for ${id}`);
const file = v.file || (v.files && v.files[0]);
if (!file || !file.url) throw new Error(`no file URL on AMO for ${id} ${version}`);
if (file.status && file.status !== "public") throw new Error(`AMO file status is "${file.status}" (not signed yet?)`);

const fr = await fetch(file.url, { headers: { Authorization: `JWT ${jwt()}` } });
if (!fr.ok) throw new Error(`download HTTP ${fr.status}`);
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${id.replace(/[^a-z0-9]/gi, "_")}-${version}.xpi`);
writeFileSync(out, Buffer.from(await fr.arrayBuffer()));
console.log(`downloaded signed ${id} ${version} → ${out}`);
