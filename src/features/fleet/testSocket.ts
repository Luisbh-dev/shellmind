// A stand-in for the fleet feed's socket in tests: records what the client
// emits, answers "fleet-subscribe" with a board, and fires server events.
import type { FleetBoard, FleetHealthEvent } from '@shared/fleet';
import type { AppSocket } from '@/lib/socket';

type Handler = (...args: unknown[]) => void;

export class FakeFleetSocket {
    readonly handlers = new Map<string, Handler[]>();
    readonly emitted: string[] = [];
    disconnected = false;

    constructor(private board: FleetBoard) {}

    on(event: string, handler: Handler): this {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
        return this;
    }

    emit(event: string, ...args: unknown[]): this {
        this.emitted.push(event);
        if (event === 'fleet-subscribe') (args[0] as (board: FleetBoard) => void)(this.board);
        return this;
    }

    disconnect(): this {
        this.disconnected = true;
        return this;
    }

    setBoard(board: FleetBoard): void {
        this.board = board;
    }

    fire(event: string, ...args: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }

    connect(): void {
        this.fire('connect');
    }

    push(event: FleetHealthEvent): void {
        this.fire('fleet-health', event);
    }

    asSocket(): AppSocket {
        return this as unknown as AppSocket;
    }
}
