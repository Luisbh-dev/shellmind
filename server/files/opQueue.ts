// Runs async operations strictly one at a time, in the order they were queued.
// basic-ftp allows a single task per connection: starting a second one while
// the first runs closes the whole connection, so every FTP call goes through
// the queue of its connection.
export class OpQueue {
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private closedWith: Error | null = null;

    run<T>(op: () => Promise<T>): Promise<T> {
        if (this.closedWith) return Promise.reject(this.closedWith);
        this.queued += 1;
        const result = this.tail.then(() => {
            if (this.closedWith) throw this.closedWith;
            return op();
        });
        this.tail = result.then(
            () => { this.queued -= 1; },
            () => { this.queued -= 1; }
        );
        return result;
    }

    // Operations waiting or running.
    get size(): number {
        return this.queued;
    }

    // Rejects every operation that has not started yet, and all later ones.
    close(reason: Error): void {
        this.closedWith = reason;
    }
}
