/**
 * Debug logger for the background side.
 *
 * Gated by Config.DEBUG (config.js) but also runtime-toggleable so you don't
 * have to reload the extension: from the background console call
 *   __ctlDebug.enable()  /  __ctlDebug.disable()  /  __ctlDebug.status()
 *
 * Everything is namespaced with a [CTL] prefix and a scope tag. Errors always
 * print (even when debug is off) so real failures are never silently swallowed.
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
    console.info("[CTL] debug ENABLED");
  },
  disable() {
    state.enabled = false;
    console.info("[CTL] debug disabled");
  },
  status() {
    console.info(`[CTL] debug is ${state.enabled ? "ON" : "OFF"}`);
    return state.enabled;
  },

  debug(scope, ...args) {
    if (state.enabled) console.debug(`[CTL ${ts()}] ${scope}:`, ...args);
  },
  info(scope, ...args) {
    if (state.enabled) console.info(`[CTL ${ts()}] ${scope}:`, ...args);
  },
  warn(scope, ...args) {
    console.warn(`[CTL ${ts()}] ${scope}:`, ...args);
  },
  error(scope, err, extra) {
    const parts = [`[CTL ${ts()}] ${scope}: ✗`];
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
    if (state.enabled) console.debug(`[CTL ${ts()}] ${scope}: ⏱ start`);
    try {
      const out = await fn();
      if (state.enabled) {
        const ms = (performance.now() - t0).toFixed(0);
        console.debug(`[CTL ${ts()}] ${scope}: ✓ done in ${ms}ms`);
      }
      return out;
    } catch (e) {
      const ms = (performance.now() - t0).toFixed(0);
      this.error(`${scope} (after ${ms}ms)`, e);
      throw e;
    }
  },
};

try {
  // eslint-disable-next-line no-undef
  (self || globalThis).__ctlDebug = log;
} catch {
  /* ignore */
}
