import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { ChatEvidence } from "../../../shared/chat";
import { attachmentKey } from "../../../shared/chatEvidence";

// The evidence makes a round trip through the client (which shows it before
// it is sent), so the backend signs what it collected: a diagnosis is only
// presented to the model as collected by ShellMind when it was. The key lives
// as long as the process; evidence from before a restart is collected again.

const KEY = randomBytes(32);
const VERSION = "v1";

type Unsigned = Omit<ChatEvidence, "signature">;

// Fixed field order, independent of how the client serializes the object.
function canonical(evidence: Unsigned): string {
    return JSON.stringify([
        VERSION,
        evidence.serverId,
        attachmentKey(evidence.attachment),
        evidence.collectedAt,
        evidence.sections.map((section) => [section.id, section.title, section.source ?? null, section.text, section.truncated === true, section.failed === true, section.readAt ?? null]),
        evidence.access ? [evidence.access.platform, evidence.access.user, evidence.access.admin, evidence.access.sudo] : null
    ]);
}

function mac(evidence: Unsigned): Buffer {
    return createHmac("sha256", KEY).update(canonical(evidence)).digest();
}

export function signEvidence(evidence: Unsigned): ChatEvidence {
    return { ...evidence, signature: `${VERSION}.${mac(evidence).toString("base64url")}` };
}

export function hasValidSignature(evidence: ChatEvidence): boolean {
    const [version, value] = evidence.signature.split(".");
    if (version !== VERSION || !value) return false;
    const given = Buffer.from(value, "base64url");
    const expected = mac(evidence);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
