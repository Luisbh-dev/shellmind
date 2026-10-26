import { describe, expect, it } from "vitest";
import { createSecretMasker, maskSecretValues } from "./secretMasker";

const SECRETS = [{ name: "password", value: "hunter2-secret" }, { name: "token", value: "tok" }];

function stream(chunks: string[]): string {
    const masker = createSecretMasker(SECRETS);
    return chunks.map((chunk) => masker.push(chunk)).join("") + masker.end();
}

describe("secret masking", () => {
    it("replaces every value with its placeholder", () => {
        expect(maskSecretValues("pw=hunter2-secret tok tok!", SECRETS)).toBe("pw={{password}} {{token}} {{token}}!");
        // Too short to look for.
        expect(maskSecretValues("ab", [{ name: "x", value: "ab" }])).toBe("ab");
    });

    it("catches a value split across chunks, wherever it is split", () => {
        const text = "before hunter2-secret after";
        for (let cut = 1; cut < text.length; cut++) {
            expect(stream([text.slice(0, cut), text.slice(cut)]), `cut at ${cut}`).toBe("before {{password}} after");
        }
        expect(stream(["hun", "ter", "2-se", "cret", "\n"])).toBe("{{password}}\n");
    });

    it("holds back only what could still be a value, and hands it on at the end", () => {
        const masker = createSecretMasker(SECRETS);
        expect(masker.push("output hun")).toBe("output ");
        expect(masker.push("dred lines")).toBe("hundred lines");
        expect(masker.push(" end hunter")).toBe(" end ");
        expect(masker.end()).toBe("hunter");
    });

    it("passes everything through when there is nothing to mask", () => {
        const masker = createSecretMasker([]);
        expect(masker.push("hunter2-secret")).toBe("hunter2-secret");
        expect(masker.end()).toBe("");
    });

    it("never splits a surrogate pair", () => {
        const masker = createSecretMasker([{ name: "emoji", value: "\u{1F600}abc" }]);
        const first = masker.push("x\u{1F600}");
        expect(first).toBe("x");
        expect(masker.push("abc")).toBe("{{emoji}}");
    });
});
