import { describe, expect, it } from 'vitest';
import { TicketBook, TicketLimitError } from './tickets';

const input = (owner = 'socket-a') => ({ serverId: 7, owner, username: 'alice', domain: 'CORP', report: () => undefined });

describe('RDP gateway tickets', () => {
    it('work once and only before they expire', () => {
        let now = 1_000;
        const book = new TicketBook(30_000, () => now);
        const first = book.issue(input());
        expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(book.claim(first.token)).toMatchObject({ id: first.id, serverId: 7 });
        expect(book.claim(first.token)).toBeNull();

        const late = book.issue(input());
        now += 30_000;
        const expired: string[] = [];
        expect(book.claim(late.token, (ticket) => expired.push(ticket.id))).toBeNull();
        // The page that asked for it can be told why.
        expect(expired).toEqual([late.id]);
        expect(book.claim(late.token, (ticket) => expired.push(ticket.id))).toBeNull();
        expect(book.claim('made-up')).toBeNull();
        expect(expired).toHaveLength(1);
    });

    it('can be dropped one by one by the socket that holds them', () => {
        const book = new TicketBook();
        const first = book.issue(input('a'));
        const second = book.issue(input('a'));
        expect(book.revoke('b', first.id)).toBe(false);
        expect(book.revoke('a', first.id)).toBe(true);
        expect(book.revoke('a', first.id)).toBe(false);
        expect(book.claim(first.token)).toBeNull();
        expect(book.claim(second.token)?.id).toBe(second.id);
    });

    it('are capped per socket and dropped with it', () => {
        const book = new TicketBook();
        const mine = [1, 2, 3, 4].map(() => book.issue(input('a')));
        expect(() => book.issue(input('a'))).toThrow(TicketLimitError);
        const other = book.issue(input('b'));
        book.revoke('a');
        expect(mine.map((ticket) => book.claim(ticket.token))).toEqual([null, null, null, null]);
        expect(book.claim(other.token)?.owner).toBe('b');
    });
});
