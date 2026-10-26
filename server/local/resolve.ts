import fs from "fs/promises";
import path from "path";

// Finds the file a command name runs, the way a shell would: a name with a
// directory part is taken as a path, a bare name is looked up on PATH. On
// Windows the PATHEXT extensions are tried (node-pty and execFile do not, so
// `node` would fail where `node.exe` works). The current directory is never
// searched.

export type ResolveOptions = {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Windows variable names are case-insensitive ("Path" is the usual spelling).
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
    if (platform !== "win32") return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
}

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
    try {
        const info = await fs.stat(file);
        if (!info.isFile()) return false;
        if (platform !== "win32") await fs.access(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export async function resolveExecutable(command: string, options: ResolveOptions = {}): Promise<string | null> {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const paths = platform === "win32" ? path.win32 : path.posix;
    const name = command.trim();
    if (!name || name.includes("\0")) return null;

    const extensions = platform === "win32"
        ? (envValue(env, "PATHEXT", platform) || DEFAULT_PATHEXT).split(";").map((ext) => ext.trim()).filter(Boolean)
        : [];
    // An explicit extension is tried as typed first ("az.cmd", "tool.exe").
    const candidatesFor = (base: string) => {
        if (platform !== "win32") return [base];
        const hasKnownExt = extensions.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()));
        return hasKnownExt ? [base] : extensions.map((ext) => base + ext.toLowerCase());
    };

    const hasDirectory = platform === "win32" ? /[\\/]/.test(name) : name.includes("/");
    if (hasDirectory) {
        for (const candidate of candidatesFor(paths.resolve(name))) {
            if (await isExecutableFile(candidate, platform)) return candidate;
        }
        return null;
    }

    const dirs = (envValue(env, "PATH", platform) || "")
        .split(paths.delimiter)
        .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
    for (const dir of dirs) {
        for (const candidate of candidatesFor(paths.join(dir, name))) {
            if (await isExecutableFile(candidate, platform)) return candidate;
        }
    }
    return null;
}
