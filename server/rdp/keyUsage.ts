import { contextTag, DerError, read, readTlv, TAG, unwrapExplicit } from "./der";

// The key usage extension (RFC 5280 4.2.1.3) of an X.509 certificate: what
// the certificate's key may be used for. connect.ts reads it to tell whether
// a certificate really needs TLS 1.2 with RSA key exchange.

// 2.5.29.15, as the content of its OBJECT IDENTIFIER.
const KEY_USAGE_OID = Buffer.from([0x55, 0x1d, 0x0f]);

// Bits of the KeyUsage BIT STRING, in its first byte (bit 0 is the highest).
const DIGITAL_SIGNATURE = 0x80;
const KEY_ENCIPHERMENT = 0x20;

export type KeyUsage = { digitalSignature: boolean; keyEncipherment: boolean };

// The key usage of a certificate (DER), or null when it has no key usage
// extension (its key may then be used for anything). Throws a DerError for
// anything that is not a well-formed certificate, or that has the extension
// twice.
export function certificateKeyUsage(der: Buffer): KeyUsage | null {
    const certificate = readTlv(der, 0);
    if (certificate.end !== der.length) throw new DerError("data after the certificate");
    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    const [tbs] = read.sequence(certificate);
    if (!tbs) throw new DerError("empty certificate");
    // TBSCertificate: ..., subjectPublicKeyInfo, [1], [2], [3] EXPLICIT Extensions
    const field = read.sequence(tbs).find((child) => child.tag === contextTag(3));
    if (!field) return null;
    let usage: KeyUsage | null = null;
    for (const extension of read.sequence(unwrapExplicit(field))) {
        // Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
        const parts = read.sequence(extension);
        if (parts.length < 2 || parts.length > 3) throw new DerError("invalid extension");
        if (parts[0].tag !== TAG.objectIdentifier) throw new DerError("an extension without its identifier");
        if (!parts[0].value.equals(KEY_USAGE_OID)) continue;
        if (usage) throw new DerError("the key usage extension appears twice");
        const value = read.octets(parts[parts.length - 1]);
        const bits = readTlv(value, 0);
        if (bits.tag !== TAG.bitString || bits.end !== value.length) throw new DerError("key usage is not a BIT STRING");
        // The count of unused bits in the last byte, then the bits.
        const [unused, first = 0] = bits.value;
        if (unused === undefined || unused > 7 || (bits.value.length === 1 && unused !== 0)) throw new DerError("invalid BIT STRING");
        usage = { digitalSignature: (first & DIGITAL_SIGNATURE) !== 0, keyEncipherment: (first & KEY_ENCIPHERMENT) !== 0 };
    }
    return usage;
}
