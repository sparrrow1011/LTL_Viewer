/**
 * Debug logger for the background side.
 *
 * Gated by Config.DEBUG (config.js) but also runtime-toggleable so you don't
 * have to reload the extension: from the background console call
 *   __ltlDebug.enable()  /  __ltlDebug.disable()  /  __ltlDebug.status()
 *
 * Everything is namespaced with a [LTL] prefix and a scope tag so you can filter
 * the console. Errors always print (even when debug is off) so real failures are
 * never silently swallowed.
 */

import { Config } from "../config.js";

const state = { enabled: !!Config.DEBUG };

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export const log = {
  get enabled() {
    return state.enabled;
  },
  enable() {
    state.enabled = true;
    console.info("[LTL] debug ENABLED");
  },
  disable() {
    state.enabled = false;
    console.info("[LTL] debug disabled");
  },
  status() {
    console.info(`[LTL] debug is ${state.enabled ? "ON" : "OFF"}`);
    return state.enabled;
  },

  /** Verbose trace — only when enabled. */
  debug(scope, ...args) {
    if (state.enabled) console.debug(`[LTL ${ts()}] ${scope}:`, ...args);
  },
  info(scope, ...args) {
    if (state.enabled) console.info(`[LTL ${ts()}] ${scope}:`, ...args);
  },
  warn(scope, ...args) {
    // Warnings print regardless — they usually matter.
    console.warn(`[LTL ${ts()}] ${scope}:`, ...args);
  },
  /** Errors always print, with full detail (incl. SpError status/body). */
  error(scope, err, extra) {
    const parts = [`[LTL ${ts()}] ${scope}: ✗`];
    if (err && err.name === "SpError") {
      parts.push(`HTTP ${err.status}`, err.message);
      if (err.body) parts.push("\n↳ body:", err.body);
    } else if (err instanceof Error) {
      parts.push(err.message, "\n↳ stack:", err.stack);
    } else {
      parts.push(err);
    }
    if (extra !== undefined) parts.push("\n↳ ctx:", extra);
    console.error(...parts);
  },

  /** Time an async op; logs start/end + duration, and rethrows on failure. */
  async time(scope, fn) {
    const t0 = performance.now();
    if (state.enabled) console.debug(`[LTL ${ts()}] ${scope}: ⏱ start`);
    try {
      const out = await fn();
      if (state.enabled) {
        const ms = (performance.now() - t0).toFixed(0);
        console.debug(`[LTL ${ts()}] ${scope}: ✓ done in ${ms}ms`);
      }
      return out;
    } catch (e) {
      const ms = (performance.now() - t0).toFixed(0);
      this.error(`${scope} (after ${ms}ms)`, e);
      throw e;
    }
  },
};

// Expose a runtime toggle on the worker's global scope.
try {
  // eslint-disable-next-line no-undef
  (self || globalThis).__ltlDebug = log;
} catch {
  /* ignore */
}
