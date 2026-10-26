import fs from "fs";
import path from "path";
import { findProjectRoot } from "./projectRoot";

// The app version: from SHELLMIND_VERSION (set by the Electron shell), else
// from ShellMind's package.json above this file, which works both under tsx
// (server/) and compiled (dist-server/server/).
function readVersion(): string {
    const fromEnv = process.env.SHELLMIND_VERSION?.trim();
    if (fromEnv) return fromEnv;

    const root = findProjectRoot();
    if (!root) return "unknown";
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
        return "unknown";
    }
}

export const APP_VERSION = readVersion();
