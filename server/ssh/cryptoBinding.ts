import { createRequire } from "module";

// ssh2 encrypts and authenticates packets with its optional native binding
// when one was built for this Node, else in JavaScript, at several times the
// CPU per MiB under system Node (measured 70-190 ms against 25-40 ms). The
// desktop app ships without it on purpose: it does not build against
// Electron's headers, and Electron's BoringSSL is fast on the JavaScript path.
export function sshCryptoBindingAvailable(): boolean {
    try {
        const crypto = createRequire(__filename)("ssh2/lib/protocol/crypto.js") as { bindingAvailable?: unknown };
        return crypto.bindingAvailable === true;
    } catch {
        return false;
    }
}

// What to tell the operator at startup, or null when nothing is missing.
export function sshCryptoNotice(available: boolean, electron = Boolean(process.versions.electron)): string | null {
    if (available || electron) return null;
    return "ssh2's native crypto binding is not built: SSH works, with more CPU per packet. Install a C++ toolchain (Python 3 and MSVC Build Tools, Xcode or build-essential), then run `npm rebuild ssh2`.";
}
