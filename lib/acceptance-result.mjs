// Only sandboxed checker output is evidence for automatic acceptance checks.
export function parseAcceptanceResult(stdout) {
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new Error("acceptance check returned non-JSON output"); }
  const statuses = ["met", "broken", "missing", "unproven", "retired"];
  if (!Array.isArray(result?.contracts) || result.contracts.some(contract =>
    !Array.isArray(contract?.criteria) || contract.criteria.some(criterion =>
      typeof criterion?.id !== "string" || !statuses.includes(criterion.status)))) {
    throw new Error("acceptance check returned invalid JSON result");
  }
  return result;
}

export function acceptanceEvidence(value) {
  if (value?.status === "not_run" || !value?.acceptanceResult) {
    throw new Error(["sandbox-unavailable", "sandbox-image-build-failed"].includes(value?.basis) ? "sandbox unavailable"
      : value?.reason || value?.detail || "sandbox acceptance produced no result");
  }
  return value.acceptanceResult;
}
