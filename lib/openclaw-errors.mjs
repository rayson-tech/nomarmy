// What a failed `openclaw agent exec` actually said, from its stderr run log.
//
// A model the provider refuses fails as "openclaw exited 1" with the reason
// buried in a colored log line. Two real cases, both listed in OpenClaw's
// catalog while every job on them failed (a Senti run):
//
//   ... decision=surface_error reason=model_not_found ... from=openai/gpt-6-sol
//   rawError={... "message":"The 'gpt-6-sol' model is not supported when
//   using Codex with a ChatGPT account."}
//
//   Unknown model: meta/muse-spark-1.3
//
// modelRejection() turns either into { model, message } so the job can say
// model_not_found with the vendor's own sentence, and health can count it.

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The provider refusing the model itself, or null for any other failure.
 * @param {string} text stderr (and/or stdout) of the failed call
 * @param {string} [attemptedModel] the provider/model the job asked for
 */
export function modelRejection(text, attemptedModel = null) {
  const s = String(text ?? "").replace(ANSI, "");
  const unknown = /Unknown model:?\s+([\w.-]+\/[\w.:-]+)/.exec(s);
  const notSupported = /The '([^'\\"]+)' model is not supported[^"\\\n]*/.exec(s);
  const flagged = /reason=model_not_found\b/.test(s);
  if (!unknown && !notSupported && !flagged) return null;
  const from = /reason=model_not_found\b[^\n]*?\bfrom=([\w.-]+\/[\w.:-]+)/.exec(s)?.[1];
  const model = (unknown?.[1] ?? from ?? attemptedModel ?? notSupported?.[1] ?? "").replace(/[.:]+$/, "") || null;
  const message = notSupported ? notSupported[0].replace(/\.?$/, ".")
    : unknown ? `Unknown model: ${model}.`
    : "the provider refused this model.";
  return { model, message };
}

/** The one-line job error for a refused model. */
export function modelRejectionLine({ model, message }) {
  return `model_not_found: ${model ?? "this model"}: ${message} It may still be listed in OpenClaw's catalog; reassign the role (nomarmy army assign <role> <agent> <model>).`;
}
