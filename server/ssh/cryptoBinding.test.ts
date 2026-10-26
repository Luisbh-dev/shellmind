import { describe, expect, it } from "vitest";
import { sshCryptoBindingAvailable, sshCryptoNotice } from "./cryptoBinding";

describe("ssh2's native crypto binding", () => {
    it("is looked up without failing, whether it was built or not", () => {
        expect(typeof sshCryptoBindingAvailable()).toBe("boolean");
    });

    it("is pointed out at startup only where it can be built and is missing", () => {
        expect(sshCryptoNotice(false, false)).toMatch(/npm rebuild ssh2/);
        expect(sshCryptoNotice(true, false)).toBeNull();
        // The desktop app ships without it on purpose.
        expect(sshCryptoNotice(false, true)).toBeNull();
    });
});
