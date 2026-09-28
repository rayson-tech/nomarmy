// Sharing what nomArmy verified, where people already look: a block for a
// pull request's description, and a README badge. Every number comes from
// the job records (lib/stats.mjs), never from a worker's report, so what
// gets shared is evidence, not a claim.

const REPO_URL = "https://github.com/rayson-tech/nomarmy";

/** Claims that held up and those caught, from computeStats' claimVsEvidence. */
function claims(stats) {
  const cv = stats.claimVsEvidence;
  const caught = cv.verificationFailed + cv.revertStillPassed;
  return { total: cv.claimedDone, caught, held: cv.claimedDone - caught, cv };
}

/**
 * Markdown for a pull request (or anywhere): what the workers claimed, what
 * nomArmy caught, the tests shown to catch their change, and high-stakes
 * reviews. `scope` names what it covers ("this feature run", "the last 7 days").
 */
export function shareMarkdown(stats, { scope = null } = {}) {
  const { total, caught, held, cv } = claims(stats);
  const rows = [];
  if (total) {
    const why = [cv.verificationFailed && `${cv.verificationFailed} failed when nomArmy ran the tests itself`, cv.revertStillPassed && `${cv.revertStillPassed} had tests that pass with the change reverted`].filter(Boolean).join(", ");
    rows.push(["Worker claims checked", `${held} of ${total} "done, tests pass" claims held up${caught ? `; ${caught} caught (${why})` : ""}`]);
  } else rows.push(["Worker claims checked", "none reported \"done, tests pass\""]);
  if (cv.provenTestFiles) rows.push(["Tests proven", `${cv.provenTestFiles} new test file(s) shown to fail without their change`]);
  if (stats.code?.committedJobs) rows.push(["Work committed", `${stats.code.committedJobs} verified job(s), +${stats.code.linesAdded} / -${stats.code.linesRemoved} lines`]);
  if (stats.highStakes?.jobs) rows.push(["High-stakes changes", `${stats.highStakes.jobs}, ${stats.highStakes.reviewed === stats.highStakes.jobs ? "all" : stats.highStakes.reviewed} independently reviewed`]);
  return [
    `### ✓ Verified by nomArmy${scope ? ` (${scope})` : ""}`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    `<sub>From nomArmy's verified job records, not the workers' own reports. [What is nomArmy?](${REPO_URL})</sub>`,
  ].join("\n");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Verdana 11px, the badge convention: rough widths by letter shape, plus padding.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[mwMW]/.test(ch) ? 10.5 : /[ijlI|.,:;!' ]/.test(ch) ? 3.8 : /[frt]/.test(ch) ? 4.8 : /[A-Z]/.test(ch) ? 7.6 : /[0-9]/.test(ch) ? 7 : ch === "·" ? 4.5 : 6.6;
  return Math.round(w + 14);
}

/**
 * A shields-style SVG: "nomArmy | 78 claims checked · 11 caught". Caught
 * claims are the point of running nomArmy, not something to hide, so the
 * color is a neutral blue, and green when every claim held up.
 */
export function badgeSvg(stats) {
  const { total, caught } = claims(stats);
  const label = "nomArmy";
  const message = !total ? "verified" : caught ? `${total} claims checked · ${caught} caught` : `${total} claims checked, all held up`;
  const color = total && !caught ? "#2da44e" : "#0969da";
  const lw = textWidth(label), mw = textWidth(message), w = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(`${label}: ${message}`)}">
  <title>${esc(`${label}: ${message}`)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + mw / 2}" y="14">${esc(message)}</text>
  </g>
</svg>
`;
}

/** The README line for a committed badge, linking to nomArmy. */
export function badgeMarkdown(relPath) {
  return `[![nomArmy](${relPath})](${REPO_URL})`;
}
