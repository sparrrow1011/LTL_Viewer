/**
 * Logger with a persistent ring buffer.
 *
 * Every line goes to the background console AND into a ring buffer that is
 * mirrored to browser.storage.local ("log"), so the sweeper page can show a
 * live "Log" tab without opening the background devtools — and the log
 * survives a background restart/wake-up, which is exactly when you need it.
 *
 * Toggle verbosity at runtime from the background console:
 *   __sweeperDebug.enable() / .disable()
 */
import { Config } from "../config.js";

const TAG = "[LobbySweeper]";
const MAX_LINES = 400;
const STORAGE_KEY = "log";

const startedAt = Date.now();
let buffer = [];
let flushTimer = null;
let loaded = false;

const fmt = (v) => {
  if (v instanceof Error) return `${v.message}${v.status ? ` (HTTP ${v.status})` : ""}${v.expired ? " [expired]" : ""}`;
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch (_) {
    return String(v);
  }
};

async function loadPrevious() {
  if (loaded) return;
  loaded = true;
  try {
    const got = await browser.storage.local.get(STORAGE_KEY);
    const prev = Array.isArray(got[STORAGE_KEY]) ? got[STORAGE_KEY] : [];
    buffer = [...prev, ...buffer].slice(-MAX_LINES);
  } catch (_) {
    /* ignore */
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: buffer });
    } catch (_) {
      /* ignore */
    }
  }, 250);
}

function push(level, scope, args) {
  const line = { t: Date.now(), level, scope, msg: args.map(fmt).join(" ") };
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer = buffer.slice(-MAX_LINES);
  scheduleFlush();
}

export const log = {
  enabled: !!Config.DEBUG,
  startedAt,
  enable() {
    this.enabled = true;
  },
  disable() {
    this.enabled = false;
  },
  info(scope, ...a) {
    console.info(TAG, `${scope}:`, ...a);
    push("info", scope, a);
  },
  warn(scope, ...a) {
    console.warn(TAG, `${scope}:`, ...a);
    push("warn", scope, a);
  },
  error(scope, ...a) {
    console.error(TAG, `${scope}:`, ...a);
    push("error", scope, a);
  },
  debug(scope, ...a) {
    if (!this.enabled) return;
    console.debug(TAG, `${scope}:`, ...a);
    push("debug", scope, a);
  },
  /** Relay trace lines a bridge returned (array of strings). */
  trace(scope, lines) {
    for (const l of lines || []) {
      console.debug(TAG, `${scope}:`, l);
      push("trace", scope, [l]);
    }
  },
  getLines: () => [...buffer],
  async clear() {
    buffer = [];
    await browser.storage.local.set({ [STORAGE_KEY]: [] });
  },
};

// No top-level await: the message listener in background.js must register
// synchronously on wake-up, so the previous log is merged in asynchronously.
loadPrevious().then(() => log.info("worker", `background (re)started — instance ${startedAt}`));

globalThis.__sweeperDebug = log;
