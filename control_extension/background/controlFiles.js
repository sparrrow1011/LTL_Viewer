/**
 * control.json documents — load and save through the GitHub contents API.
 * Schema/normalise/serialise live in shared/controlDoc.js (also used by the page).
 */

import { Config } from "../config.js";
import * as gh from "./github.js";
import { normalize, serialize, cmpVersion } from "../shared/controlDoc.js";

const extOf = (slug) => {
  const ext = Config.EXTS.find((x) => x.slug === slug);
  if (!ext) throw new Error(`Unknown extension slug: ${slug}`);
  return ext;
};

/** Load one add-on's control.json + latest published version. */
export async function load(slug) {
  const ext = extOf(slug);
  const [file, latest] = await Promise.all([gh.readFile(`${slug}/control.json`), gh.latestVersion(slug)]);
  if (!file.exists) {
    const err = new Error(`No ${slug}/control.json on the ${Config.BRANCH} branch yet — the sign workflow seeds it on the first release of ${ext.name}.`);
    err.status = 404;
    throw err;
  }
  let doc;
  try {
    doc = normalize(JSON.parse(file.text));
  } catch (e) {
    throw new Error(`${slug}/control.json is not valid JSON (${e.message}) — fix it on GitHub first.`);
  }
  return { slug, name: ext.name, doc, sha: file.sha, latest };
}

export async function loadAll() {
  const out = {};
  await Promise.all(
    Config.EXTS.map(async (ext) => {
      try {
        out[ext.slug] = await load(ext.slug);
      } catch (e) {
        out[ext.slug] = { slug: ext.slug, name: ext.name, error: String((e && e.message) || e), status: e && e.status };
      }
    })
  );
  return out;
}

/**
 * Save a draft. Re-reads the sha right before writing so a concurrent edit
 * (admin page, control.ps1, another admin) surfaces as a conflict rather than
 * being silently overwritten.
 */
export async function save(slug, draft, summary) {
  extOf(slug);
  const doc = normalize(draft);
  const path = `${slug}/control.json`;
  const cur = await gh.readFile(path);
  if (!cur.exists) throw new Error(`${path} disappeared from the ${Config.BRANCH} branch — reload.`);
  // Guard: a minVersion above the latest published build would lock everyone out.
  const latest = await gh.latestVersion(slug);
  if (doc.minVersion && latest && cmpVersion(doc.minVersion, latest) > 0) {
    throw new Error(`Minimum version ${doc.minVersion} is higher than the latest published ${latest} — that would block every install. Not saved.`);
  }
  const res = await gh.writeFile(path, serialize(doc), `${slug} control: ${summary || "edit"}`, cur.sha);
  return { slug, doc, sha: res.sha, commit: res.commit, latest };
}
