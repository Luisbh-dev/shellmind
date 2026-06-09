// Single source of truth for the backend location.
//
// The bundled Electron app and `npm start` both run the backend on
// localhost:3001. A custom origin can be injected at build time via
// `VITE_API_BASE` (e.g. when hosting the web build behind a reverse proxy).

const ENV_API_BASE = (import.meta as any).env?.VITE_API_BASE as string | undefined;

export const API_BASE = ENV_API_BASE && ENV_API_BASE.trim()
    ? ENV_API_BASE.replace(/\/+$/, "")
    : "http://localhost:3001";

// socket.io shares the same origin as the HTTP API.
export const SOCKET_URL = API_BASE;
