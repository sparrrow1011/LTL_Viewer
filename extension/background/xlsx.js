/**
 * Minimal .xlsx reader — no dependencies, no bundler.
 *
 * WHY: the CST shipper list is maintained by hand in "Source of Truth
 * 2026.xlsx" on SharePoint. Everything downstream used to depend on someone
 * running CST_viewer's scripts/update_shippers.py to publish a CSV, which meant
 * the extension served a stale list whenever that hadn't been run. Reading the
 * workbook directly removes that step.
 *
 * An .xlsx is a ZIP of XML parts, so this does two small jobs:
 *   1. ZIP: read the central directory, inflate the parts we need
 *      (DecompressionStream("deflate-raw"), Firefox 113+; manifest floor is 115).
 *   2. XML: pull the sheet by name, resolve its part via the rels, expand the
 *      shared-string table, and emit cells keyed by column letter.
 *
 * Only what's needed to read a flat sheet is implemented: no styles, formulas,
 * dates or number formats. Values come back as trimmed strings, which is all the
 * shipper list needs (ids, names, groups).
 *
 * Validated against the real workbook before being wired in: 127 shippers, an
 * identical id set to the published source_of_truth_crawler.csv.
 */

// ── ZIP ──────────────────────────────────────────────────────────────────────

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Inflate the named entries of a ZIP. `wanted` is a predicate on the entry
 * name, so we only decompress the few parts we actually read.
 * @returns {Promise<Map<string, Uint8Array>>}
 */
async function unzip(bytes, wanted = () => true) {
  // End of central directory record: scan back for its signature.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66_000); // 64K comment + header
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid .xlsx (no ZIP end-of-directory record)");

  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error("corrupt .xlsx (bad central directory)");
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOff = u32(bytes, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wanted(name)) {
      // The local header repeats name/extra at its own lengths — skip those to
      // find the data, rather than trusting the central copy.
      const lNameLen = u16(bytes, localOff + 26);
      const lExtraLen = u16(bytes, localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + compSize);
      out.set(name, method === 0 ? raw : await inflateRaw(raw));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── XML ──────────────────────────────────────────────────────────────────────

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // last, so &amp;lt; doesn't become <
}

/** Shared strings: cells of type "s" hold an index into this table. */
function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>|<si\s*\/>/g) || []) {
    // Rich text splits one string across several <t> runs — join them.
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
    out.push(parts.join(""));
  }
  return out;
}

const columnOf = (ref) => (ref.match(/^([A-Z]+)/) || ["", ""])[1];

/** Sheet XML → array of rows, each an object keyed by column letter. */
function sheetRows(xml, strings) {
  const rows = [];
  for (const rowXml of xml.match(/<row[\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const cells = {};
    for (const cm of rowXml.matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c ${cm[1]}>`;
      const inner = cm[3] || "";
      const ref = attrOf(tag, "r") || "";
      const type = attrOf(tag, "t");
      let value = "";
      if (type === "inlineStr") {
        const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = im ? unescapeXml(im[1]) : "";
      } else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const rawVal = vm ? unescapeXml(vm[1]) : "";
        value = type === "s" ? strings[Number(rawVal)] ?? "" : rawVal;
      }
      if (ref) cells[columnOf(ref)] = String(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Read one sheet out of an .xlsx.
 * @param {Uint8Array} bytes      the whole file
 * @param {string} sheetName      sheet to read, matched case-insensitively
 * @returns {Promise<{rows: object[], sheets: string[], part: string}>}
 *          rows keyed by column letter ({ B: "...", C: "...", L: "..." }),
 *          including the header row as rows[0].
 */
export async function readSheet(bytes, sheetName) {
  const need = (n) =>
    n === "xl/workbook.xml" ||
    n === "xl/_rels/workbook.xml.rels" ||
    n === "xl/sharedStrings.xml" ||
    n.startsWith("xl/worksheets/");
  const zip = await unzip(bytes, need);
  const text = (name) => (zip.has(name) ? new TextDecoder().decode(zip.get(name)) : null);

  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("not a valid .xlsx (no xl/workbook.xml)");

  const sheetTags = workbook.match(/<sheet[^>]*\/>|<sheet[^>]*>/g) || [];
  const sheets = sheetTags.map((s) => attrOf(s, "name")).filter(Boolean);
  const want = String(sheetName).trim().toLowerCase();
  const tag = sheetTags.find((s) => (attrOf(s, "name") || "").trim().toLowerCase() === want);
  if (!tag) {
    throw new Error(`sheet "${sheetName}" not found — workbook has: ${sheets.join(", ")}`);
  }

  // Resolve r:id → part name via the workbook rels.
  const rid = attrOf(tag, "r:id") || attrOf(tag, "id");
  const rels = text("xl/_rels/workbook.xml.rels") || "";
  const relTag = (rels.match(/<Relationship[^>]*\/>/g) || []).find((r) => attrOf(r, "Id") === rid);
  let part = null;
  if (relTag) {
    const target = (attrOf(relTag, "Target") || "").replace(/^\/?xl\//, "").replace(/^\//, "");
    part = `xl/${target}`;
  }
  // Fall back to sheet order when the rels are unusual.
  if (!part || !zip.has(part)) {
    const i = sheetTags.indexOf(tag);
    part = `xl/worksheets/sheet${i + 1}.xml`;
  }
  const sheetXml = text(part);
  if (!sheetXml) throw new Error(`sheet "${sheetName}" part missing (${part})`);

  return { rows: sheetRows(sheetXml, sharedStrings(text("xl/sharedStrings.xml"))), sheets, part };
}

/** base64 (how the bridge ships bytes over runtime messaging) → Uint8Array. */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
