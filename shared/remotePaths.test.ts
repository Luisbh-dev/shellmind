import { describe, expect, it } from "vitest";
import {
    MAX_NAME_BYTES,
    MAX_S3_KEY_BYTES,
    baseName,
    isWithin,
    joinRemotePath,
    nameProblem,
    normalizeRemotePath,
    parentPath,
    pathNameProblem,
    temporaryUploadPath,
    truncateUtf8,
    utf8Length
} from "./remotePaths";

describe("normalizeRemotePath", () => {
    it("resolves dot segments and repeated or trailing slashes", () => {
        expect(normalizeRemotePath("/srv//app/./x/..")).toBe("/srv/app");
        expect(normalizeRemotePath("/srv/app/")).toBe("/srv/app");
        expect(normalizeRemotePath("")).toBe("/");
        expect(normalizeRemotePath("relative/dir")).toBe("/relative/dir");
    });

    it("never climbs above the root", () => {
        expect(normalizeRemotePath("/../../etc")).toBe("/etc");
        expect(normalizeRemotePath("/a/../..")).toBe("/");
    });

    it("keeps Windows drive paths of SFTP servers", () => {
        expect(normalizeRemotePath("/C:/Users/admin/")).toBe("/C:/Users/admin");
    });
});

describe("path parts", () => {
    it("splits parent and name", () => {
        expect(parentPath("/a/b/c.txt")).toBe("/a/b");
        expect(parentPath("/a")).toBe("/");
        expect(parentPath("/")).toBe("/");
        expect(baseName("/a/b/c.txt")).toBe("c.txt");
        expect(baseName("/")).toBe("");
        expect(joinRemotePath("/a/", "b")).toBe("/a/b");
        expect(joinRemotePath("/", "etc")).toBe("/etc");
    });

    it("tells whether a path is inside another", () => {
        expect(isWithin("/a/b", "/a")).toBe(true);
        expect(isWithin("/a", "/a")).toBe(true);
        expect(isWithin("/ab", "/a")).toBe(false);
        expect(isWithin("/x", "/")).toBe(true);
    });
});

describe("names", () => {
    it("accepts plain names only, and says why not", () => {
        expect(nameProblem("notes.txt")).toBeNull();
        expect(nameProblem(".env")).toBeNull();
        expect(nameProblem("")).toBe("empty");
        expect(nameProblem("a/b")).toBe("slash");
        expect(nameProblem("nul\0byte")).toBe("slash");
        expect(nameProblem(".")).toBe("dots");
        expect(nameProblem("..")).toBe("dots");
        expect(nameProblem("x".repeat(256))).toBe("tooLong");
        expect(nameProblem("x".repeat(255))).toBeNull();
    });

    it("counts the bytes the file system counts, not characters", () => {
        // 128 characters, 256 bytes: too long for NAME_MAX.
        const accented = "é".repeat(128);
        expect(accented.length).toBe(128);
        expect(utf8Length(accented)).toBe(256);
        expect(nameProblem(accented)).toBe("tooLong");
        expect(nameProblem("é".repeat(127))).toBeNull();
        expect(utf8Length("😀")).toBe(4);
    });

    // S3 has no NAME_MAX: names the bucket takes (up to a 1024-byte key)
    // must not be refused by the SFTP rule, and keys beyond that must be.
    it("limits S3 names by the whole key, not by NAME_MAX", () => {
        const accented = "é".repeat(200);
        const cjk = "文".repeat(100);
        expect(nameProblem(accented)).toBe("tooLong");
        expect(nameProblem(cjk, "ftp")).toBe("tooLong");
        expect(nameProblem(accented, "s3", "/photos")).toBeNull();
        expect(nameProblem(cjk, "s3", "/")).toBeNull();
        expect(nameProblem("x".repeat(600), "s3", "/a")).toBeNull();
        // "/" + key + the "/" a folder's key ends with.
        expect(nameProblem("x".repeat(MAX_S3_KEY_BYTES - 1), "s3", "/")).toBeNull();
        expect(nameProblem("x".repeat(MAX_S3_KEY_BYTES), "s3", "/")).toBe("keyTooLong");
        expect(nameProblem("x".repeat(1000), "s3", `/${"d".repeat(30)}`)).toBe("keyTooLong");
        expect(nameProblem("a/b", "s3")).toBe("slash");
        expect(pathNameProblem(`/photos/${accented}`, "s3")).toBeNull();
        expect(pathNameProblem(`/photos/${accented}`, "sftp")).toBe("tooLong");
        expect(pathNameProblem("/", "s3")).toBe("empty");
    });

    it("shortens text at a character boundary", () => {
        expect(truncateUtf8("abc", 2)).toBe("ab");
        expect(truncateUtf8("aé", 2)).toBe("a");
        expect(truncateUtf8("a😀b", 4)).toBe("a");
        expect(truncateUtf8("a😀b", 5)).toBe("a😀");
        expect(truncateUtf8("short", 100)).toBe("short");
    });
});

describe("temporaryUploadPath", () => {
    it("puts temporary uploads next to their target, hidden", () => {
        expect(temporaryUploadPath("/etc/nginx/nginx.conf", "ab12")).toBe("/etc/nginx/.nginx.conf.shellmind-ab12.part");
    });

    // BC-12: a valid name of 231 to 255 bytes used to give a temporary name
    // longer than NAME_MAX, so its upload or editor save failed.
    it("stays a valid name for the longest valid targets", () => {
        for (const name of ["x".repeat(240), "x".repeat(MAX_NAME_BYTES), "ñ".repeat(127), `${"a".repeat(250)}😀`]) {
            expect(nameProblem(name)).toBeNull();
            const temp = baseName(temporaryUploadPath(`/srv/${name}`, "deadbeef"));
            expect(utf8Length(temp)).toBeLessThanOrEqual(MAX_NAME_BYTES);
            expect(temp.startsWith(`.${name.slice(0, 100)}`)).toBe(true);
            expect(temp.endsWith(".shellmind-deadbeef.part")).toBe(true);
            expect(temp).not.toContain("\uFFFD");
        }
        expect(parentPath(temporaryUploadPath(`/srv/${"x".repeat(250)}`, "deadbeef"))).toBe("/srv");
    });
});
