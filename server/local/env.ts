// Environment of the local shells and CLIs the backend spawns: its own minus
// the backend's settings and secrets. A user process has no use for them,
// `env` in a terminal would print them, and terminal output is sent to the AI
// provider as context. server/config already removes the secrets it reads;
// this also covers any added later.
//   SHELLMIND_*            session token, credentials key and other settings
//   GEMINI_*, MINIMAX_*    the AI providers' keys and proxy credentials
//   *_API_KEY              any other API key handed to the backend
//   ELECTRON_RUN_AS_NODE   set for the packaged backend; an Electron app
//                          started from a terminal would run as plain Node
//   DB_PATH                where the backend keeps its database (and the
//                          credentials key file next to it)
const DROPPED = /^(SHELLMIND_|GEMINI_|MINIMAX_)|_API_KEY$|^ELECTRON_RUN_AS_NODE$|^DB_PATH$/;

export function localProcessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        // Windows variable names are case-insensitive.
        if (DROPPED.test(name.toUpperCase())) delete env[name];
    }
    return env;
}
