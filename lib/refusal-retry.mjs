import { claimModelRefusalRetry, modelRefusals, recordModelRefusal, recordProbeSuccess } from "./health.mjs";

/** Start eligible one-token probes without waiting for them in the caller. */
export function retryRefusedModelsInBackground(stateRoot, { probeModel, now = Date.now() } = {}) {
  if (!probeModel) return;
  for (const key of Object.keys(modelRefusals(stateRoot))) {
    if (!claimModelRefusalRetry(stateRoot, key, { now })) continue;
    const slash = key.indexOf("/");
    if (slash < 1 || slash === key.length - 1) continue;
    const provider = key.slice(0, slash), model = key.slice(slash + 1);
    Promise.resolve().then(() => probeModel({ provider, model, stateRoot })).then((result) => {
      if (result?.ok) recordProbeSuccess(stateRoot, key, { now });
      else if (result?.refused) recordModelRefusal(stateRoot, key, result.reason, { now });
    }).catch(() => { /* An inconclusive probe keeps the refusal and retry timestamp. */ });
  }
}
