import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { findProjectRoot } from "../projectRoot";
import { defaultDbPath, nativeLoadError } from "./sqlite";

const root = path.resolve(__dirname, "..", "..");

describe("the database file", () => {
    it("defaults to the repository root, also for the compiled backend", () => {
        expect(defaultDbPath()).toBe(path.join(root, "shellmind.db"));
        // dist-server/server/db/sqlite.js finds the same root (not dist-server/).
        expect(findProjectRoot(path.join(root, "dist-server", "server", "db"))).toBe(root);
        expect(findProjectRoot(os.tmpdir())).toBeNull();
    });
});

describe("a native module that cannot load", () => {
    const dlopen = Object.assign(new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found"), { code: "ERR_DLOPEN_FAILED" });

    it("says how to rebuild it, or that the package does not fit the system", () => {
        expect(nativeLoadError(dlopen, false)?.message).toMatch(/GLIBC_2\.38.*npm run postinstall/);
        expect(nativeLoadError(dlopen, true)?.message).toMatch(/cannot run on this system/);
        expect(nativeLoadError(dlopen, false)?.cause).toBe(dlopen);
        expect(nativeLoadError(new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 127"), false)).not.toBeNull();
    });

    it("leaves any other failure as it is", () => {
        expect(nativeLoadError(new Error("Cannot find module 'sqlite3'"), false)).toBeNull();
    });
});
