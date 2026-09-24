// Imported first by every test file that can reach nomArmy's global config.
// Global config lives in ~/.config/nomarmy (lib/army.mjs's
// globalConfigDir), so without this a test run on a developer's machine
// would read, or write, their real providers.yml, subscriptions.yml and
// army config.yml. Points it at a fresh empty directory instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NOMARMY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-global-"));
