import os from "os";
import { localProcessEnv } from "./env";
import { runCommand } from "./process";
import { resolveExecutable } from "./resolve";

// Tool names are looked up and run as given, never through a shell; anything
// that is not a plain program name is refused outright.
const TOOL_NAME = /^[A-Za-z0-9._-]+$/;

// True if `bin` is a program on PATH. Never throws.
export async function checkCommandExists(bin: string): Promise<boolean> {
    if (!TOOL_NAME.test(bin)) return false;
    try {
        return (await resolveExecutable(bin, { env: localProcessEnv() })) !== null;
    } catch {
        return false;
    }
}

// Best-effort one-line context for the chat greeting: the tool's version for a
// scoped CLI (`<bin> --version`), or the host OS for a local shell. Never throws.
export async function detectLocalContext(bin?: string): Promise<string> {
    if (!bin) return `${os.type()} ${os.release()}`;
    if (!TOOL_NAME.test(bin)) return "";
    try {
        const env = localProcessEnv();
        const file = await resolveExecutable(bin, { env });
        if (!file) return "";
        // W8-T2: kubectl has no --version flag ("error: unknown flag").
        const args = bin === "kubectl" ? ["version", "--client"] : ["--version"];
        const { stdout, stderr } = await runCommand(file, args, { env, timeoutMs: 5000 });
        const first = `${stdout}\n${stderr}`.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)[0] || "";
        return /not recognized|not found|no such file|cannot find|^error:/i.test(first) ? "" : first.slice(0, 100);
    } catch {
        return "";
    }
}
