import fs from "fs";
import path from "path";

// The folder of ShellMind's package.json above `from` (this file by default):
// the repository root both under tsx (server/) and compiled
// (dist-server/server/). null when there is none (a bundle without it).
export function findProjectRoot(from: string = __dirname): string | null {
    let dir = from;
    for (let depth = 0; depth < 5; depth++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
            if (pkg?.name === "shellmind") return dir;
        } catch {
            // No (readable) package.json at this level: keep walking up.
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}
