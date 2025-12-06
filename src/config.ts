// In development (Electron), the backend is at localhost:3001
// In production (web), it might be the same origin.
// Ideally this is environment based.

const isElectron = navigator.userAgent.toLowerCase().indexOf(' electron/') > -1;

export const API_BASE = "http://localhost:3001";
