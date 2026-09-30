/**
 * SMC request recorder — diagnostics for building the "Create draft" step.
 *
 * While recording, every POST/PUT/PATCH the SMC page sends (except our own
 * search calls) is captured with its decoded body and stored in
 * storage.local["pg.recorded"] (last 30). The user creates ONE draft by hand
 * in SMC, then copies the capture from the overlay's Settings panel. That's
 * how we learn the create-order endpoint + payload without DevTools.
 *
 * Uses browser.webRequest (non-blocking, "requestBody"), which Firefox MV3
 * supports. Recording is off by default and stops itself after 30 minutes.
 */
import { Config } from "../config.js";
import { log } from "./debug.js";

const KEY = "pg.recorded";
const MAX = 100;
const AUTO_STOP_MS = 30 * 60_000;
// Calls we already understand (captured 2026-09-29 while filling the create
// form): they fire on every keystroke and would drown the one we still need,
// the save/create request itself.
const NOISE =
  /\/shipper\/order\/search|\/shipper\/location\/search|\/configuration\/constants|\/shipper\/order\/suggest-order-window|\/shipper\/order\/wait-time|\/mileage\/calculate|\/transit-time\/calculate|\/contract\/get-matching-contract-for-request|\/shipper\/order\/tax\/estimates/;

const state = { on: false, timer: null, pending: new Map() };

function decodeBody(details) {
  const rb = details.requestBody;
  if (!rb) return "";
  if (rb.formData) return JSON.stringify(rb.formData);
  if (rb.raw && rb.raw.length) {
    try {
      const dec = new TextDecoder("utf-8");
      return rb.raw.map((p) => (p.bytes ? dec.decode(p.bytes) : p.file ? `<file ${p.file}>` : "")).join("");
    } catch (e) {
      return `<undecodable body: ${e.message}>`;
    }
  }
  return "";
}

async function push(entry) {
  const cur = (await browser.storage.local.get(KEY))[KEY] || [];
  cur.push(entry);
  while (cur.length > MAX) cur.shift();
  await browser.storage.local.set({ [KEY]: cur });
}

function onBeforeRequest(details) {
  if (!state.on) return;
  if (!/^(POST|PUT|PATCH)$/i.test(details.method)) return;
  if (NOISE.test(details.url)) return;
  const body = decodeBody(details);
  state.pending.set(details.requestId, {
    at: new Date().toISOString(),
    method: details.method,
    url: details.url,
    type: details.type,
    body: body.length > 60_000 ? body.slice(0, 60_000) + `…<${body.length - 60_000} more chars>` : body,
  });
  log.info("rec", `${details.method} ${details.url} (${body.length} bytes)`);
}

function onCompleted(details) {
  const e = state.pending.get(details.requestId);
  if (!e) return;
  state.pending.delete(details.requestId);
  e.status = details.statusCode;
  push(e).catch((err) => log.warn("rec", `store failed: ${err.message}`));
}

function onError(details) {
  const e = state.pending.get(details.requestId);
  if (!e) return;
  state.pending.delete(details.requestId);
  e.status = 0;
  e.error = details.error;
  push(e).catch(() => {});
}

const FILTER = { urls: [Config.SMC_TAB_MATCH], types: ["xmlhttprequest", "main_frame", "sub_frame"] };

export async function start() {
  if (!browser.webRequest) throw new Error("webRequest API unavailable — reload the add-on so the manifest permission applies.");
  if (!state.on) {
    browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER, ["requestBody"]);
    browser.webRequest.onCompleted.addListener(onCompleted, FILTER);
    browser.webRequest.onErrorOccurred.addListener(onError, FILTER);
    state.on = true;
    log.info("rec", "recording SMC requests");
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(() => stop().catch(() => {}), AUTO_STOP_MS);
  return status();
}

export async function stop() {
  if (state.on) {
    browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    browser.webRequest.onCompleted.removeListener(onCompleted);
    browser.webRequest.onErrorOccurred.removeListener(onError);
    state.on = false;
    log.info("rec", "stopped");
  }
  clearTimeout(state.timer);
  state.timer = null;
  return status();
}

export async function status() {
  const list = (await browser.storage.local.get(KEY))[KEY] || [];
  return { on: state.on, count: list.length };
}

export async function get() {
  const list = (await browser.storage.local.get(KEY))[KEY] || [];
  return { on: state.on, entries: list };
}

export async function clear() {
  await browser.storage.local.remove(KEY);
  return status();
}
