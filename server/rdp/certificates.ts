import { createHash, X509Certificate } from "crypto";
import type { PinnedRdpCertificate, RdpCertificate } from "../../shared/rdp";
import { dbAll, dbGet, dbRun } from "../db/sqlite";

// RDP servers present a TLS certificate, usually self-signed (Windows makes
// one and renews it every few months). The gateway pins the first one seen
// per host, port and jump route and refuses another one until the user, who
// compared both, trusts the new one: the same model as SSH host keys.

type Row = {
    id: number;
    host: string;
    port: number;
    via: string;
    fingerprint: string;
    thumbprint: string;
    subject: string;
    issuer: string;
    valid_from: number | null;
    valid_to: number | null;
    created_at: number;
};

const toPin = (row: Row): PinnedRdpCertificate => ({
    id: row.id,
    host: row.host,
    port: row.port,
    via: row.via,
    fingerprint: row.fingerprint,
    thumbprint: row.thumbprint,
    subject: row.subject,
    issuer: row.issuer,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at
});

const hexPairs = (digest: Buffer) => [...digest].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");

// Distinguished names on one line ("CN=host, O=Org"), for display only.
function oneLine(name: string): string {
    return name.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(", ").slice(0, 512);
}

function parseDate(text: string): number | null {
    const time = Date.parse(text);
    return Number.isFinite(time) ? time : null;
}

// What the gateway records of a certificate (DER).
export function describeCertificate(der: Buffer, endpoint: { host: string; port: number; via: string }): RdpCertificate {
    const fingerprint = hexPairs(createHash("sha256").update(der).digest());
    const thumbprint = createHash("sha1").update(der).digest("hex").toUpperCase();
    let subject = "";
    let issuer = "";
    let validFrom: number | null = null;
    let validTo: number | null = null;
    try {
        const parsed = new X509Certificate(der);
        subject = oneLine(parsed.subject);
        issuer = oneLine(parsed.issuer);
        validFrom = parseDate(parsed.validFrom);
        validTo = parseDate(parsed.validTo);
    } catch {
        // Pinned by its bytes all the same; the details are only shown.
    }
    return { ...endpoint, fingerprint, thumbprint, subject, issuer, validFrom, validTo };
}

export const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export const rdpCertificates = {
    async find(host: string, port: number, via: string): Promise<PinnedRdpCertificate | null> {
        const row = await dbGet<Row>("SELECT * FROM rdp_certificates WHERE host = ? AND port = ? AND via = ?", [host, port, via]);
        return row ? toPin(row) : null;
    },

    async get(id: number): Promise<PinnedRdpCertificate | null> {
        const row = await dbGet<Row>("SELECT * FROM rdp_certificates WHERE id = ?", [id]);
        return row ? toPin(row) : null;
    },

    async list(): Promise<PinnedRdpCertificate[]> {
        return (await dbAll<Row>("SELECT * FROM rdp_certificates ORDER BY host, port, via")).map(toPin);
    },

    // Pins `certificate` unless one is already pinned for its endpoint, and
    // returns the pinned one (another connection may have won the race).
    async pin(certificate: RdpCertificate): Promise<PinnedRdpCertificate> {
        await dbRun(
            `INSERT INTO rdp_certificates (host, port, via, fingerprint, thumbprint, subject, issuer, valid_from, valid_to, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(host, port, via) DO NOTHING`,
            [certificate.host, certificate.port, certificate.via, certificate.fingerprint, certificate.thumbprint,
                certificate.subject, certificate.issuer, certificate.validFrom, certificate.validTo, Date.now()]
        );
        const pinned = await rdpCertificates.find(certificate.host, certificate.port, certificate.via);
        if (!pinned) throw new Error(`Could not pin the certificate of ${certificate.host}:${certificate.port}`);
        return pinned;
    },

    // Swaps the pin of the endpoint for `certificate`, but only while the
    // pinned one is still `expected` (one statement: nothing can pin another
    // certificate in between). Pins it if nothing is pinned. Returns the pin
    // afterwards, whichever it is.
    async replace(certificate: RdpCertificate, expected: string): Promise<PinnedRdpCertificate> {
        const { changes } = await dbRun(
            `UPDATE rdp_certificates SET fingerprint = ?, thumbprint = ?, subject = ?, issuer = ?, valid_from = ?, valid_to = ?, created_at = ?
             WHERE host = ? AND port = ? AND via = ? AND fingerprint = ?`,
            [certificate.fingerprint, certificate.thumbprint, certificate.subject, certificate.issuer, certificate.validFrom,
                certificate.validTo, Date.now(), certificate.host, certificate.port, certificate.via, expected]
        );
        if (changes > 0) {
            const pinned = await rdpCertificates.find(certificate.host, certificate.port, certificate.via);
            if (pinned) return pinned;
        }
        return rdpCertificates.pin(certificate);
    },

    async remove(id: number): Promise<boolean> {
        const { changes } = await dbRun("DELETE FROM rdp_certificates WHERE id = ?", [id]);
        return changes > 0;
    }
};

export type RdpCertificateStore = Pick<typeof rdpCertificates, "find" | "pin">;
