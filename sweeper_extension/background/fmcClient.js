/**
 * FMC client (background side). Routes through content/fmc-bridge.js.
 */
import { Config } from "../config.js";
import { makeBridge } from "./bridgeClient.js";

const bridge = makeBridge({
  name: "fmc",
  tabMatch: Config.FMC_TAB_MATCH,
  tabUrl: Config.FMC_TAB_URL,
  script: "content/fmc-bridge.js",
});

export async function ping() {
  await bridge.call({ action: "fmc:ping" });
  return true;
}

/**
 * by-id search for VRIDs (and, best effort, order IDs).
 * @returns {Promise<Array<{vrid,status,carrier,carrierName,tour,orderIds:string[]}>>}
 */
export async function byId(ids, onProgress) {
  const clean = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))];
  const size = 50; // fmc_api.py BATCH_SIZE
  const batches = Math.ceil(clean.length / size);
  const records = [];
  // One ≤50-id request per bridge round-trip (keeps the event page alive).
  for (let i = 0; i < batches; i++) {
    const resp = await bridge.call({ action: "fmc:batch", ids: clean.slice(i * size, (i + 1) * size) });
    records.push(...(resp.records || []));
    if (onProgress) onProgress(i + 1, batches, records.length);
  }
  return records;
}
