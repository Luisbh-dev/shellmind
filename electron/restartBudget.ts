// How often something that crashed (the backend, the window's renderer) is
// restarted on its own: at most `max` times within `windowMs`. More crashes
// than that mean the restarts do not help, and the user decides instead.
export class RestartBudget {
    private times: number[] = [];

    constructor(private readonly max: number, private readonly windowMs: number) {}

    // Records a crash at `now`. False once the budget is spent; the record
    // then starts over, so the restart the user asks for gets a fresh budget.
    take(now: number = Date.now()): boolean {
        this.times = [...this.times.filter((time) => now - time < this.windowMs), now];
        if (this.times.length <= this.max) return true;
        this.times = [];
        return false;
    }
}
