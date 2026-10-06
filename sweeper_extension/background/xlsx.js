/**
 * Minimal .xlsx reader — no dependencies, no bundler.
 *
 * WHY: the HC calculator's hours come from the HAT workbook, which lives in a
 * SharePoint document library. The Python app read it with pandas/openpyxl; in
 * the browser we fetch the bytes through the SharePoint bridge and parse them
 * here. An .xlsx is a ZIP of XML, so this file is two small parsers:
 *
 *   1. ZIP: central directory walk + DecompressionStream("deflate-raw")
 *      (Firefox 113+; the manifest requires 115).
 *   2. SpreadsheetML: sharedStrings, the number formats that mean "date", and
 *      the cells of the sheets we ask for.
 *
 * XML is scanned with regexes rather than DOMParser: the shapes involved are
 * tiny and fixed, and this keeps the module usable from any context.
 *
 * Output is a SPARSE GRID per sheet — grid[row][col], holding only cells that
 * have a value (string | number | boolean | Date); missing rows and empty cells
 * are holes, so read it through a helper that treats undefined as blank. That mirrors what the Python
 * did with df.iloc[row, col], with ONE deliberate difference: pandas consumed
 * the first sheet row as a header, so pandas' df.iloc[r, c] is this grid's
 * [r + 1][c]. hatSource.js works in grid coordinates and finds its own
 * anchors, so the offset never has to be reasoned about again.
 */

import { log } from "./debug.js";

// ── ZIP ───────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(view, len) {
  // The EOCD is at least 22 bytes and may be followed by a comment (≤ 64 KB).
  const from = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= from; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Inflate a ZIP entry as a stream of chunks, so a very large sheet is never
 * held in memory whole. Breaking out of the consuming loop cancels the rest of
 * the decompression (the generator's finally runs).
 */
async function* inflateChunks(entry) {
  if (entry.method === 0) {
    yield entry.raw;
    return;
  }
  if (entry.method !== 8) throw new Error(`Corrupt .xlsx: unsupported compression method ${entry.method}`);
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "This browser can't decompress the workbook (DecompressionStream is missing). Firefox 113 or newer is required."
    );
  }
  const reader = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

/**
 * The ZIP's entries (not decompressed): { name: { method, raw } }. Only the
 * entries whose name passes `want(name)` are kept.
 */
function entries(bytes, want = () => true) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const eocd = findEocd(view, len);
  if (eocd < 0) {
    throw new Error("Not a readable .xlsx (no ZIP end-of-central-directory record found)");
  }
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("The workbook uses ZIP64, which this reader doesn't support");
  }
  const dec = new TextDecoder();
  const out = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || view.getUint32(p, true) !== CDH_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (view.getUint32(localOffset, true) !== LFH_SIG) {
      throw new Error(`Corrupt .xlsx: bad local header for ${name}`);
    }
    // Sizes on the local header can be zero (data descriptor): trust the
    // central directory's compressed size.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    out[name] = { method, raw: bytes.subarray(start, start + compSize) };
  }
  return out;
}

/** An entry, fully inflated (only for the small parts: workbook, rels, styles, strings). */
async function inflateAll(entry) {
  const chunks = [];
  let total = 0;
  for await (const c of inflateChunks(entry)) {
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Read a ZIP archive into { name: Uint8Array }. Only the entries whose name
 * passes `want(name)` are decompressed. For big sheets use readSheets, which
 * streams instead.
 * @param {Uint8Array} bytes
 * @param {(name: string) => boolean} [want]
 */
export async function unzip(bytes, want = () => true) {
  const list = entries(bytes, want);
  const out = {};
  for (const [name, entry] of Object.entries(list)) out[name] = await inflateAll(entry);
  return out;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] != null ? ENTITIES[ent] : m;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

function textOf(xml) {
  // Concatenate every <t>…</t> run, skipping <rPh> (phonetic) blocks.
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\/>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1] != null ? unescapeXml(m[1]) : "";
  return out;
}

// ── shared strings / styles ───────────────────────────────────────────────────

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] != null ? textOf(m[1]) : "");
  return out;
}

// Built-in number formats that render as a date and/or time.
const DATE_BUILTINS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function looksLikeDateFormat(code) {
  if (!code) return false;
  // Strip quoted literals, escapes, colour/condition blocks and currency, then
  // look for a date/time placeholder.
  const bare = String(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare);
}

/**
 * Which cell styles (the `s` attribute) mean "this number is a date".
 * @returns {Set<number>}
 */
function parseDateStyles(xml) {
  const dateStyles = new Set();
  if (!xml) return dateStyles;

  // Custom formats first: numFmtId -> formatCode.
  const custom = new Map();
  const nfRe = /<numFmt\s[^>]*\/>/g;
  let m;
  while ((m = nfRe.exec(xml))) {
    const id = parseInt(attr(m[0], "numFmtId"), 10);
    const code = attr(m[0], "formatCode");
    if (Number.isFinite(id)) custom.set(id, code || "");
  }

  // cellXfs is the style table cells point at; its order IS the style index.
  const block = xml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (!block) return dateStyles;
  const xfRe = /<xf\s[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
  let idx = 0;
  while ((m = xfRe.exec(block[0]))) {
    const id = parseInt(attr(m[0], "numFmtId"), 10);
    if (Number.isFinite(id)) {
      if (DATE_BUILTINS.has(id)) dateStyles.add(idx);
      else if (custom.has(id) && looksLikeDateFormat(custom.get(id))) dateStyles.add(idx);
    }
    idx += 1;
  }
  return dateStyles;
}

// ── cells ─────────────────────────────────────────────────────────────────────

/** "BC12" -> 54 (0-based column index). */
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break; // hit the row digits
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Excel serial -> Date (UTC). Serials below 61 predate the workbook's phantom
// 29-Feb-1900, so they need the classic off-by-one correction.
const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01
export function serialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const days = n < 61 ? n + 1 : n;
  return new Date(Math.round((days - EXCEL_EPOCH_OFFSET) * 86400000));
}

/** One cell's value, or undefined for an empty/error cell (nothing is stored). */
function cellValue(tag, inner, shared, dateStyles) {
  const t = attr(tag, "t");
  if (t === "inlineStr") {
    const s = textOf(inner);
    return s === "" ? undefined : s;
  }
  const vm = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  const raw = vm ? unescapeXml(vm[1]) : "";
  if (raw === "") return undefined;
  if (t === "s") {
    const s = shared[parseInt(raw, 10)] ?? "";
    return s === "" ? undefined : s;
  }
  if (t === "str") return raw;
  if (t === "b") return raw === "1" || raw.toLowerCase() === "true";
  if (t === "e") return undefined; // #N/A and friends: same as blank for us
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const styleAttr = attr(tag, "s");
  const style = styleAttr == null ? -1 : parseInt(styleAttr, 10);
  return dateStyles.has(style) ? serialToDate(n) : n;
}

const ROW_RE = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
const CELL_RE = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CARRY_LIMIT = 8 * 1024 * 1024; // chars of unparsed tail before cell-less rows are dropped

/**
 * Parse one sheet by STREAMING its XML: inflate chunk by chunk, parse every
 * complete <row> as it arrives, and keep only cells that hold a value.
 *
 * Why this shape: the HAT's Daily Tracker is very wide (a column per day) and
 * sheets are often formatted far past their data. Inflating the whole part,
 * decoding it into one string and building a dense grid ran the background out
 * of memory. Here memory is bounded by the cells that have values, and with
 * `maxRows` the stream is abandoned as soon as the rows we need are read.
 *
 * The grid is SPARSE: grid[r] may be undefined, grid[r][c] may be a hole.
 * Read it through a helper that treats both as null.
 *
 * @returns {Promise<{grid: Array<Array<*>>, rowsRead: number, stoppedEarly: boolean}>}
 */
async function parseSheetStream(entry, shared, dateStyles, { maxRows = Infinity } = {}) {
  const grid = [];
  const dec = new TextDecoder();
  let carry = "";
  let rowsRead = 0;
  let stoppedEarly = false;

  // Returns true once a row past maxRows is seen (the caller then stops).
  const consume = (text) => {
    ROW_RE.lastIndex = 0;
    let m;
    while ((m = ROW_RE.exec(text))) {
      const rAttr = attr(`<row ${m[1]}>`, "r");
      const rowNo = rAttr ? parseInt(rAttr, 10) - 1 : rowsRead;
      if (rowNo >= maxRows) return true;
      rowsRead = Math.max(rowsRead, rowNo + 1);
      CELL_RE.lastIndex = 0;
      let c;
      while ((c = CELL_RE.exec(m[2]))) {
        const tag = `<c ${c[1]}>`;
        const ref = attr(tag, "r");
        if (!ref) continue;
        const col = colIndex(ref);
        if (col < 0) continue;
        const v = cellValue(tag, c[2] || "", shared, dateStyles);
        if (v === undefined) continue; // empty formatted cells cost nothing
        (grid[rowNo] || (grid[rowNo] = []))[col] = v;
      }
    }
    return false;
  };

  for await (const chunk of inflateChunks(entry)) {
    carry += dec.decode(chunk, { stream: true });
    const end = carry.lastIndexOf("</row>");
    if (end < 0) {
      // A long run of cell-less self-closing rows never produces "</row>";
      // drop them so the tail can't grow without bound.
      if (carry.length > CARRY_LIMIT) carry = carry.replace(/<row\b[^>]*\/>/g, "");
      continue;
    }
    const head = carry.slice(0, end + 6);
    carry = carry.slice(end + 6);
    if (consume(head)) {
      stoppedEarly = true;
      break; // cancels the rest of the decompression
    }
  }
  if (!stoppedEarly) {
    carry += dec.decode();
    consume(carry);
  }
  return { grid, rowsRead, stoppedEarly };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Read the named sheets of a workbook.
 *
 * @param {Uint8Array} bytes           the .xlsx file
 * @param {string[]|null} [wanted]     sheet names to parse (null = all). Names
 *                                     are matched case-insensitively.
 * @param {{maxRows?: Record<string, number>}} [opts]
 *        maxRows: per sheet name (case-insensitive), stop reading after this
 *        many rows. Everything else is read in full.
 * @returns {Promise<{ names: string[], sheets: Record<string, Array<Array<*>>>, stats: object }>}
 *          `names` is every sheet in the workbook (so a caller can report what
 *          it found when an expected sheet is missing). Grids are sparse.
 */
export async function readSheets(bytes, wanted = null, { maxRows = {} } = {}) {
  const t0 = Date.now();
  // Pass 1: the parts needed to resolve sheet name -> part path.
  const meta = await unzip(bytes, (n) =>
    n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || n === "xl/styles.xml"
  );
  const dec = new TextDecoder();
  const wbXml = meta["xl/workbook.xml"] ? dec.decode(meta["xl/workbook.xml"]) : "";
  if (!wbXml) throw new Error("Not a readable .xlsx (xl/workbook.xml is missing)");
  const relsXml = meta["xl/_rels/workbook.xml.rels"] ? dec.decode(meta["xl/_rels/workbook.xml.rels"]) : "";

  const rels = new Map();
  let m;
  const relRe = /<Relationship\s[^>]*\/>/g;
  while ((m = relRe.exec(relsXml))) {
    const id = attr(m[0], "Id");
    let target = attr(m[0], "Target");
    if (!id || !target) continue;
    target = target.replace(/^\//, "").replace(/^xl\//, "");
    rels.set(id, `xl/${target}`);
  }

  const sheets = [];
  const shRe = /<sheet\s[^>]*\/>/g;
  while ((m = shRe.exec(wbXml))) {
    const name = attr(m[0], "name");
    const rid = attr(m[0], "r:id") || attr(m[0], "id");
    if (!name) continue;
    const part = (rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, part });
  }
  const names = sheets.map((s) => s.name);

  const wantSet = wanted ? new Set(wanted.map((n) => String(n).trim().toLowerCase())) : null;
  const picked = wantSet ? sheets.filter((s) => wantSet.has(s.name.trim().toLowerCase())) : sheets;
  if (!picked.length) return { names, sheets: {} };

  // Pass 2: only the sheet parts we need — located, not inflated.
  const parts = new Set(picked.map((s) => s.part));
  const list = entries(bytes, (n) => parts.has(n));

  const shared = parseSharedStrings(meta["xl/sharedStrings.xml"] ? dec.decode(meta["xl/sharedStrings.xml"]) : "");
  const dateStyles = parseDateStyles(meta["xl/styles.xml"] ? dec.decode(meta["xl/styles.xml"]) : "");
  // The meta XML strings aren't needed past this point; let them go.
  for (const k of Object.keys(meta)) delete meta[k];

  const limits = new Map(Object.entries(maxRows || {}).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  const out = {};
  const stats = {};
  for (const s of picked) {
    const entry = list[s.part];
    if (!entry) {
      log.warn("xlsx", `sheet '${s.name}' points at missing part ${s.part}`);
      continue;
    }
    const limit = limits.get(s.name.trim().toLowerCase());
    const t1 = Date.now();
    const { grid, rowsRead, stoppedEarly } = await parseSheetStream(entry, shared, dateStyles, {
      maxRows: limit == null ? Infinity : limit,
    });
    out[s.name] = grid;
    stats[s.name] = { rowsRead, stoppedEarly, compressedKB: Math.round(entry.raw.length / 1024), ms: Date.now() - t1 };
  }
  log.debug(
    "xlsx",
    `parsed ${Object.keys(out).length}/${names.length} sheet(s) in ${Date.now() - t0}ms ` +
      `(${shared.length} shared strings, ${dateStyles.size} date styles)`,
    stats
  );
  return { names, sheets: out, stats };
}
