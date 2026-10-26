import { describe, expect, it } from 'vitest';
import { OpQueue } from './opQueue';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OpQueue', () => {
    it('runs operations one at a time in submission order', async () => {
        const queue = new OpQueue();
        const events: string[] = [];
        let running = 0;
        let maxRunning = 0;
        const op = (name: string, ms: number) => queue.run(async () => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            events.push(`start ${name}`);
            await tick(ms);
            events.push(`end ${name}`);
            running -= 1;
            return name;
        });
        const results = await Promise.all([op('list', 15), op('download', 5), op('mkdir', 1)]);
        expect(results).toEqual(['list', 'download', 'mkdir']);
        expect(maxRunning).toBe(1);
        expect(events).toEqual(['start list', 'end list', 'start download', 'end download', 'start mkdir', 'end mkdir']);
    });

    it('keeps going after a failed operation', async () => {
        const queue = new OpQueue();
        const failed = queue.run(async () => { throw new Error('550 denied'); });
        const next = queue.run(async () => 'ok');
        await expect(failed).rejects.toThrow('550 denied');
        await expect(next).resolves.toBe('ok');
        expect(queue.size).toBe(0);
    });

    it('rejects queued and later operations once closed', async () => {
        const queue = new OpQueue();
        const running = queue.run(() => tick(10).then(() => 'done'));
        const waiting = queue.run(async () => 'never');
        await tick(1);
        queue.close(new Error('closed'));
        await expect(running).resolves.toBe('done');
        await expect(waiting).rejects.toThrow('closed');
        await expect(queue.run(async () => 'late')).rejects.toThrow('closed');
    });
});
