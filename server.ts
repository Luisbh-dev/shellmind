// Backend entry point, compiled to dist-server/server.js (the file Electron forks).
// server/config loads .env, so it must stay the first import.
import { HOST, PORT } from "./server/config";
import { errorMessage } from "./server/errors";
import { exitFatally } from "./server/lifecycle";
import { start } from "./server/main";

// start() reports its own failures; anything that still escapes it must reach
// the parent as {type:"fatal"} and exit 1, never end the process cleanly.
start({ port: PORT, host: HOST }).catch((err: unknown) => exitFatally(`Could not start: ${errorMessage(err)}`, err));
