/**
 * Debug logger for the background side (P&G TMS Viewer).
 *
 * Gated by Config.DEBUG but runtime-toggleable from the background console:
 *   __pgDebug.enable() / .disable() / .status()
 * Errors always print even when debug is off.
 */

import { Config } from "../config.js";

const state = { enabled: !!Config.DEBUG };
const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  get enabled() {
    return state.enabled;
  },
  enable() {
    state.enabled = true;
    console.info("[PG] debug ENABLED");
  },
  disable() {
    state.enabled = false;
    console.info("[PG] debug disabled");
  },
  status() {
    console.info(`[PG] debug is ${state.enabled ? "ON" : "OFF"}`);
    return state.enabled;
  },
  debug(scope, ...a) {
    if (state.enabled) console.debug(`[PG ${ts()}] ${scope}:`, ...a);
  },
  info(scope, ...a) {
    if (state.enabled) console.info(`[PG ${ts()}] ${scope}:`, ...a);
  },
  warn(scope, ...a) {
    console.warn(`[PG ${ts()}] ${scope}:`, ...a);
  },
  error(scope, err, extra) {
    const parts = [`[PG ${ts()}] ${scope}: ✗`];
    if (err instanceof Error) parts.push(err.message, "\n↳ stack:", err.stack);
    else parts.push(err);
    if (extra !== undefined) parts.push("\n↳ ctx:", extra);
    console.error(...parts);
  },
  async time(scope, fn) {
    const t0 = performance.now();
    if (state.enabled) console.debug(`[PG ${ts()}] ${scope}: ⏱ start`);
    try {
      const out = await fn();
      if (state.enabled)
        console.debug(`[PG ${ts()}] ${scope}: ✓ done in ${(performance.now() - t0).toFixed(0)}ms`);
      return out;
    } catch (e) {
      this.error(`${scope} (after ${(performance.now() - t0).toFixed(0)}ms)`, e);
      throw e;
    }
  },
};

try {
  (self || globalThis).__pgDebug = log;
} catch {
  /* ignore */
}
