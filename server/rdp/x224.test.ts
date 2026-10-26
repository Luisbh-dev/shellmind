import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { connectionConfirm, connectionRequest } from '../../test/helpers/rdpServer';
import { FrameTimeoutError, parseConnectionConfirm, parseConnectionRequest, readTpktFrame, tpktLength, X224Error } from './x224';

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ''), 'hex');

describe('X.224 Connection Request', () => {
    it('reads the cookie and the requested protocols', () => {
        expect(parseConnectionRequest(connectionRequest({ user: 'alice', protocols: 0x0b }))).toEqual({ cookie: 'Cookie: mstshash=alice', requestedProtocols: 0x0b });
    });

    it('accepts a request without negotiation data or with correlation info', () => {
        expect(parseConnectionRequest(connectionRequest({ protocols: null })).requestedProtocols).toBeNull();
        const base = connectionRequest({ protocols: 0x03 });
        const correlation = Buffer.alloc(36);
        correlation[0] = 0x06;
        correlation.writeUInt16LE(36, 2);
        const body = Buffer.concat([base.subarray(4), correlation]);
        body[0] = body.length - 1;
        const frame = Buffer.concat([hex('03 00 00 00'), body]);
        frame.writeUInt16BE(frame.length, 2);
        expect(parseConnectionRequest(frame).requestedProtocols).toBe(0x03);
    });

    it('refuses frames whose lengths disagree', () => {
        const frame = connectionRequest();
        const longer = Buffer.from(frame);
        longer.writeUInt16BE(frame.length + 1, 2);
        expect(() => parseConnectionRequest(longer)).toThrow(/TPKT length/);
        const badLi = Buffer.from(frame);
        badLi[4] += 1;
        expect(() => parseConnectionRequest(badLi)).toThrow(/length indicator/);
    });

    it('refuses other TPDUs, unterminated cookies and stray data', () => {
        expect(() => parseConnectionRequest(connectionConfirm(null))).toThrow(/TPDU code/);
        const frame = connectionRequest({ protocols: null });
        const unterminated = Buffer.from(frame);
        unterminated[unterminated.length - 1] = 0x41;
        expect(() => parseConnectionRequest(unterminated)).toThrow(/not terminated/);
        const extra = Buffer.concat([connectionRequest().subarray(4), hex('99')]);
        extra[0] = extra.length - 1;
        const tpkt = Buffer.concat([hex('03 00 00 00'), extra]);
        tpkt.writeUInt16BE(tpkt.length, 2);
        expect(() => parseConnectionRequest(tpkt)).toThrow(/unexpected data/);
    });

    it('refuses what is not TPKT or out of bounds', () => {
        expect(() => tpktLength(hex('16 03 01 00 a5'))).toThrow(/not a TPKT/);
        expect(() => tpktLength(hex('03 00 00 05'))).toThrow(/too short/);
        expect(() => tpktLength(hex('03 00 ff ff'))).toThrow(/too long/);
        expect(tpktLength(hex('03 00'))).toBeNull();
    });
});

describe('X.224 Connection Confirm', () => {
    it('tells the selected protocol, a failure or a legacy server apart', () => {
        expect(parseConnectionConfirm(hex('030000130ed00000123400022f080008000000'))).toEqual({ kind: 'response', selectedProtocol: 8 });
        expect(parseConnectionConfirm(connectionConfirm({ type: 'failure', value: 5 }))).toEqual({ kind: 'failure', code: 5 });
        expect(parseConnectionConfirm(connectionConfirm(null))).toEqual({ kind: 'legacy' });
        expect(() => parseConnectionConfirm(connectionRequest())).toThrow(X224Error);
    });
});

describe('readTpktFrame', () => {
    it('reads exactly one frame, however it is split, and puts the rest back', async () => {
        const stream = new PassThrough();
        const frame = connectionConfirm({ type: 'response', value: 2 });
        const pending = readTpktFrame(stream, 1000);
        stream.write(frame.subarray(0, 3));
        stream.write(Buffer.concat([frame.subarray(3), hex('16 03')]));
        expect(await pending).toEqual(frame);
        expect(stream.isPaused()).toBe(true);
        expect(stream.read()).toEqual(hex('16 03'));
    });

    it('fails on a timeout, a closed stream or garbage', async () => {
        await expect(readTpktFrame(new PassThrough(), 20)).rejects.toBeInstanceOf(FrameTimeoutError);
        const ended = new PassThrough();
        const pending = readTpktFrame(ended, 1000);
        ended.end(hex('03 00'));
        await expect(pending).rejects.toThrow(/closed the connection/);
        const garbage = new PassThrough();
        const refused = readTpktFrame(garbage, 1000);
        garbage.write('HTTP/1.1 400 Bad Request\r\n');
        await expect(refused).rejects.toThrow(/not a TPKT/);
    });
});
