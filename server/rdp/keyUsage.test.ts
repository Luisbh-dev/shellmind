import { describe, expect, it } from 'vitest';
import { digitalSignatureCertificate, KEY_USAGE, keyEnciphermentCertificate, rsaCertificate } from '../../scripts/check-rdp-tls.mjs';
import { selfSignedCertificate } from '../../test/helpers/rdpServer';
import { DerError, encodeTlv, write } from './der';
import { certificateKeyUsage } from './keyUsage';

// The parts of a certificate the reader walks, built by hand: no signature
// is checked, only the structure.
const OID = { keyUsage: [0x55, 0x1d, 0x0f], extKeyUsage: [0x55, 0x1d, 0x25] };
const oid = (bytes: number[]) => encodeTlv(0x06, Buffer.from(bytes));
const TRUE = Buffer.from([0x01, 0x01, 0xff]);
const bitString = (...bytes: number[]) => encodeTlv(0x03, Buffer.from(bytes));
const extension = (id: number[], value: Buffer, critical = true) => write.sequence([oid(id), ...(critical ? [TRUE] : []), write.octets(value)]);
const keyUsage = (value: Buffer, critical?: boolean) => extension(OID.keyUsage, value, critical);
const serverAuth = extension(OID.extKeyUsage, write.sequence([oid([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])]), false);

function certificate(extensions: Buffer[] | null, before: Buffer[] = []): Buffer {
    const algorithm = write.sequence([oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00])]);
    const tbs = write.sequence([
        write.explicit(0, write.unsigned(2)),
        write.unsigned(4660),
        algorithm,
        write.sequence([]),
        write.sequence([]),
        write.sequence([]),
        write.sequence([]),
        ...before,
        ...(extensions ? [write.explicit(3, write.sequence(extensions))] : []),
    ]);
    return write.sequence([tbs, algorithm, bitString(0x00, 0x01, 0x02)]);
}

describe('certificateKeyUsage', () => {
    it('reads the key usage of real certificates', () => {
        // What Windows makes for RDP: key encipherment and data encipherment.
        expect(certificateKeyUsage(keyEnciphermentCertificate('WIN-RDP').der)).toEqual({ digitalSignature: false, keyEncipherment: true });
        expect(certificateKeyUsage(digitalSignatureCertificate('SIGNING').der)).toEqual({ digitalSignature: true, keyEncipherment: true });
        expect(certificateKeyUsage(rsaCertificate('SIGN-ONLY', KEY_USAGE.digitalSignature).der)).toEqual({ digitalSignature: true, keyEncipherment: false });
        // No extension: the key may be used for anything.
        expect(certificateKeyUsage(rsaCertificate('ANY-USE', null).der)).toBeNull();
        expect(certificateKeyUsage(selfSignedCertificate('no-extensions').der)).toBeNull();
    });

    it('finds the extension among others, critical or not, after the unique identifiers', () => {
        expect(certificateKeyUsage(certificate([serverAuth, keyUsage(bitString(0x05, 0xa0))]))).toEqual({ digitalSignature: true, keyEncipherment: true });
        expect(certificateKeyUsage(certificate([keyUsage(bitString(0x04, 0x30), false), serverAuth]))).toEqual({ digitalSignature: false, keyEncipherment: true });
        // issuerUniqueID [1] and subjectUniqueID [2], both IMPLICIT BIT STRING.
        const uniqueIds = [encodeTlv(0x81, Buffer.from([0x00, 0x01])), encodeTlv(0x82, Buffer.from([0x00, 0x02]))];
        expect(certificateKeyUsage(certificate([keyUsage(bitString(0x07, 0x80))], uniqueIds))).toEqual({ digitalSignature: true, keyEncipherment: false });
        // Bits beyond the first byte (decipherOnly) do not matter here; no bit at all is no usage.
        expect(certificateKeyUsage(certificate([keyUsage(bitString(0x07, 0x20, 0x80))]))).toEqual({ digitalSignature: false, keyEncipherment: true });
        expect(certificateKeyUsage(certificate([keyUsage(bitString(0x00))]))).toEqual({ digitalSignature: false, keyEncipherment: false });
        expect(certificateKeyUsage(certificate([serverAuth]))).toBeNull();
        expect(certificateKeyUsage(certificate(null))).toBeNull();
    });

    it('refuses what is not a well-formed certificate, or one with the extension twice', () => {
        const good = keyEnciphermentCertificate('WIN-RDP').der;
        for (const der of [
            Buffer.alloc(0),
            Buffer.from('not a certificate'),
            good.subarray(0, good.length - 1),
            Buffer.concat([good, Buffer.from([0x00])]),
            write.sequence([]),
            write.utf8('certificate'),
            certificate([keyUsage(bitString(0x04, 0x30)), keyUsage(bitString(0x05, 0xa0))]),
            certificate([keyUsage(write.octets(Buffer.from([0x30])))]),
            certificate([keyUsage(Buffer.concat([bitString(0x04, 0x30), Buffer.from([0x00])]))]),
            certificate([keyUsage(bitString(0x08, 0x30))]),
            certificate([keyUsage(bitString(0x04))]),
            certificate([keyUsage(encodeTlv(0x03, Buffer.alloc(0)))]),
            certificate([write.sequence([oid(OID.keyUsage)])]),
            certificate([write.sequence([write.utf8('2.5.29.15'), write.octets(bitString(0x04, 0x30))])]),
        ]) {
            expect(() => certificateKeyUsage(der)).toThrow(DerError);
        }
    });
});
