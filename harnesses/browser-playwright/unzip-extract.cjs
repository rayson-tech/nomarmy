// Preloaded (NODE_OPTIONS=--require) only while the sandbox image installs a
// browser for Playwright before 1.60 on Node 24.16 or later. Its bundled
// extract-zip hangs there forever, after the download completes
// (nodejs/node#63487, fixed in Playwright 1.60), so this hands that one step
// to the system unzip. Everything else Playwright does is unchanged.
const Module = require("node:module");
const { execFile } = require("node:child_process");

const load = Module._load;
Module._load = function (request, parent) {
  const loaded = load.apply(this, arguments);
  if (/(^|[\\/])zipBundle$/.test(request) && /playwright-core/.test(parent?.filename ?? "")) {
    return {
      ...loaded,
      extract: (zipPath, { dir }) => new Promise((resolve, reject) => {
        execFile("unzip", ["-q", "-o", zipPath, "-d", dir], (error) => (error ? reject(error) : resolve()));
      }),
    };
  }
  return loaded;
};
