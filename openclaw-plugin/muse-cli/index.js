import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMuseCliBackend } from "./backend.js";

export default definePluginEntry({
  id: "muse-cli",
  name: "Muse Code CLI",
  description: "Meta Muse Code through its own CLI (muse exec), for a Muse Code subscription.",
  register(api) {
    api.registerCliBackend(buildMuseCliBackend());
  },
});
