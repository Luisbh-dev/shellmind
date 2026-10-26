// Load .env before any other module reads process.env. server.ts imports this
// module first, and every module that reads configuration imports it too.
import "dotenv/config";

// Backend port; 0 lets the OS pick a free one (the Electron shell reads the
// actual port from the "ready" IPC message).
const rawPort = process.env.PORT?.trim() ?? "";
export const PORT = /^\d{1,5}$/.test(rawPort) && Number(rawPort) <= 65535 ? Number(rawPort) : 3001;

// SQLite database location; server/db/sqlite.ts falls back to a default path.
export const DB_PATH = process.env.DB_PATH;

// Base64-encoded 32-byte key for the credentials stored in the database. When
// empty, server/security/secrets.ts uses (or creates) shellmind.key next to it.
export const DATA_KEY = process.env.SHELLMIND_DATA_KEY?.trim() || "";

// Start over with a new data key when the database holds encrypted
// credentials but its key is missing: those credentials are cleared.
export const RESET_DATA_KEY = /^(1|true|yes|on)$/i.test(process.env.SHELLMIND_RESET_DATA_KEY?.trim() || "");

// Verbose protocol logging (ssh2 packets, FTP control channel). Off by default:
// it logs every packet and grows the log without bound.
export const DEBUG = /^(1|true|yes|on)$/i.test(process.env.SHELLMIND_DEBUG?.trim() || "");

const DEFAULT_MINIMAX_PROXY_URL = "https://ai-proxy.luisbh.com";
export const MINIMAX_PROXY_URL = (process.env.MINIMAX_PROXY_URL?.trim() || DEFAULT_MINIMAX_PROXY_URL).replace(/\/+$/, "");
export const MINIMAX_PROXY_BASE_URL = MINIMAX_PROXY_URL.endsWith("/anthropic/v1")
    ? MINIMAX_PROXY_URL
    : `${MINIMAX_PROXY_URL}/anthropic/v1`;
export const ALLOW_CLIENT_MINIMAX_KEY = !/^(0|false|no|off)$/i.test(process.env.ALLOW_CLIENT_MINIMAX_KEY || "true");
export const MINIMAX_PROXY_API_KEY = process.env.MINIMAX_PROXY_API_KEY?.trim() || "";
export const MINIMAX_PROXY_BEARER_TOKEN = process.env.MINIMAX_PROXY_BEARER_TOKEN?.trim() || "";

// Official MiniMax Anthropic-compatible endpoint, called directly when the user
// configured their own MiniMax key (https://api.minimaxi.com/anthropic in China).
export const MINIMAX_API_BASE_URL = (process.env.MINIMAX_API_BASE_URL?.trim() || "https://api.minimax.io/anthropic").replace(/\/+$/, "");

// Extra browser origins allowed to call the API (comma-separated, for web deploys).
export const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

// Interface the backend listens on. Loopback by default: anything else should
// sit behind a reverse proxy and be listed in ALLOWED_HOSTS / ALLOWED_ORIGINS.
export const HOST = process.env.HOST?.trim() || "127.0.0.1";

// Extra Host header values accepted (comma-separated, `name` or `name:port`).
// Loopback names and the hosts of ALLOWED_ORIGINS are always accepted.
export const EXTRA_ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);

// Session token required by every API request and socket connection; when
// empty the server generates one at startup.
export const AUTH_TOKEN = process.env.SHELLMIND_AUTH_TOKEN?.trim() || "";

// Secrets handed over by the parent process are removed from the environment
// once read (DATA_KEY above), so shells and CLIs spawned by the backend never
// see them: `env` in a local terminal would print them.
delete process.env.SHELLMIND_AUTH_TOKEN;
delete process.env.SHELLMIND_DATA_KEY;

const isEnabled = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() || "");

// Set by the desktop app, whose UI is a file:// page: accept the Origin values
// such a page sends ("file://" on WebSocket handshakes, "null" elsewhere).
// Any website can send "null" from a sandboxed iframe, so it is refused
// everywhere else.
export const ALLOW_FILE_ORIGIN = isEnabled(process.env.SHELLMIND_ALLOW_FILE_ORIGIN);

// Serve the built web UI (dist/) from the backend itself (`npm run serve`).
// WEB_DIR overrides where the build is looked up.
export const SERVE_WEB = isEnabled(process.env.SERVE_WEB);
export const WEB_DIR = process.env.WEB_DIR?.trim() || "";

// Log verbosity: error, warn, info (default) or debug. SHELLMIND_DEBUG=1 (DEBUG
// above) forces debug.
export const LOG_LEVEL = process.env.LOG_LEVEL?.trim().toLowerCase() || "";

// --- W7-S2 identities ---
// The SSH agent identities that "use the SSH agent" sign in with: a socket or
// Windows pipe path, "pageant", or "off". When empty: SSH_AUTH_SOCK, then on
// Windows the OpenSSH agent pipe, then Pageant, and only while HOST is
// loopback (server/ssh/agent.ts explains why).
export const SSH_AGENT = process.env.SHELLMIND_SSH_AGENT?.trim() || "";
export const SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK?.trim() || "";

// How the PowerShell scripts of the status, operations, fleet, patch, disk and
// diagnosis features reach Windows servers: on stdin (default), or "encoded"
// (-EncodedCommand on the command line), the fallback for an SSH server that
// does not pass a command's stdin on. server/ops/remote.ts explains both.
export const POWERSHELL_DELIVERY: "stdin" | "encoded" = /^encoded$/i.test(process.env.SHELLMIND_POWERSHELL_DELIVERY?.trim() || "") ? "encoded" : "stdin";
