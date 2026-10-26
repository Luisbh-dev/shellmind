import { describe, expect, it, vi } from "vitest";
import type { AuditInput } from "../../shared/types";
import type { ServerStepContext } from "../multiexec/runner";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import type { SshLease } from "../ssh/pool";
import { BOOT_CHECK_SCRIPT, REBOOT_SCRIPT } from "./scripts";
import { bootedAgain, createPatchStep, parseBootState, upSeconds, type StepDeps } from "./step";

// The patch step against a scripted host and a fake clock: the run's output
// decides whether it reboots, and the reboot waits for SSH, tells a new boot
// from the old one and checks the system it comes back to.

type HostState = { bootId: string; pid1: string; uptime: number; state: string | null; failed: number };

type FakeHostOptions = {
    // What the run prints (its last line says whether a reboot is required).
    output?: string;
    exitCode?: number;
    // How long the host is down after the reboot command (ms of fake time).
    downMs?: number;
    // How the reboot changes the host (default: a new boot id, running).
    after?: Partial<HostState>;
    // States reported one after the other once it is back (systemd settling).
    settling?: string[];
    rebootReply?: { code: number; stderr?: string };
    // Fails every connection once it is back (e.g. rejected credentials).
    connectError?: unknown;
    // Logins refused this many times once it answers (pam_nologin while it
    // shuts down and boots), then accepted.
    refusedLogins?: number;
    // The reboot does not happen.
    noReboot?: boolean;
    before?: Partial<HostState>;
};

function fakeHost(options: FakeHostOptions = {}) {
    let now = 1_000_000;
    let host: HostState = { bootId: "boot-1", pid1: "200", uptime: 86_400, state: "running", failed: 0, ...options.before };
    let downUntil: number | null = null;
    let refusals = options.refusedLogins ?? 0;
    const settling = [...(options.settling ?? [])];
    const audit: AuditInput[] = [];
    // Each entry as it was first written (before it was completed).
    const sent: AuditInput[] = [];
    // The fleet maintenance asked for: how long from then (null: it ended).
    const maintenance: Array<{ serverId: number; until: number | null }> = [];
    const closed: number[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const leases: Array<SshLease & { released: boolean }> = [];
    const makeLease = (name: string) => {
        const lease = { serverId: 3, client: {}, target: { os: "linux" }, released: false, name, release() { lease.released = true; }, onClose: () => () => undefined };
        leases.push(lease as unknown as SshLease & { released: boolean });
        return lease as unknown as SshLease & { released: boolean };
    };
    const bootOutput = () => [
        "@@SM:boot", host.bootId, "@@SM:pid1", host.pid1, "@@SM:hz", "100", "@@SM:uptime", String(host.uptime),
        "@@SM:state", host.state ?? "", "@@SM:failed", host.state === null ? "" : String(host.failed), "@@SM:end", ""
    ].join("\n");
    const deps: StepDeps = {
        stream: async (_lease, _script, io) => {
            io.onData(options.output ?? "[shellmind] manager=apt\n[shellmind] reboot-required=yes\n");
            return { code: options.exitCode ?? 0, signal: null };
        },
        run: async (_lease, script) => {
            if (script === BOOT_CHECK_SCRIPT) {
                if (settling.length) host = { ...host, state: settling.shift()! };
                return { stdout: bootOutput(), stderr: "", code: 0, signal: null };
            }
            if (script === REBOOT_SCRIPT) {
                if (options.rebootReply) return { stdout: "", stderr: options.rebootReply.stderr ?? "", code: options.rebootReply.code, signal: null };
                if (!options.noReboot) {
                    downUntil = now + (options.downMs ?? 30_000);
                    host = { bootId: "boot-2", pid1: "150", uptime: 5, state: "running", failed: 0, ...options.after };
                }
                throw Object.assign(new Error("Connection lost before handshake"), { code: "ECONNRESET" });
            }
            throw new Error(`unexpected script ${script.slice(0, 40)}`);
        },
        acquire: async () => {
            if (downUntil !== null && now < downUntil) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:22"), { code: "ECONNREFUSED" });
            if (options.connectError && downUntil !== null) throw options.connectError;
            if (refusals > 0 && downUntil !== null) {
                refusals -= 1;
                throw Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
            }
            return makeLease("after");
        },
        close: (serverId) => closed.push(serverId),
        sleep: async (ms) => {
            now += ms;
            host = { ...host, uptime: host.uptime + ms / 1000 };
        },
        now: () => now,
        record: async (entry) => {
            audit.push(entry);
            sent.push({ ...entry });
            return { id: audit.length };
        },
        complete: async (id, completion) => {
            audit[id - 1] = { ...audit[id - 1], ...completion };
        },
        maintenance: {
            begin: (serverId, untilMs) => maintenance.push({ serverId, until: untilMs - now }),
            end: (serverId) => maintenance.push({ serverId, until: null })
        }
    };
    const lease = makeLease("first");
    const context: ServerStepContext = {
        target: { serverId: 3, name: "web", host: "10.0.0.3", type: "linux" },
        lease,
        signal: new AbortController().signal,
        onData: (text) => output.push(text),
        onStderr: (text) => errors.push(text),
        auditMeta: { jobId: "job-1", servers: 1 }
    };
    return { deps, context, audit, sent, maintenance, closed, leases, text: () => output.join(""), errors: () => errors.join(""), clock: () => now };
}

const step = (host: ReturnType<typeof fakeHost>, options: { reboot?: boolean; jumpHosts?: number[]; rebootWaitMs?: number } = {}) => createPatchStep({
    script: "run",
    reboot: options.reboot ?? true,
    rebootWaitMs: options.rebootWaitMs ?? 600_000,
    jumpHosts: new Set(options.jumpHosts ?? [])
}, host.deps)(host.context);

describe("the patch step", () => {
    it("only runs the script when the run does not reboot", async () => {
        const host = fakeHost();
        await expect(step(host, { reboot: false })).resolves.toEqual({ code: 0, signal: null });
        expect(host.closed).toEqual([]);
        expect(host.audit).toEqual([]);
    });

    it("leaves a server alone that needs no reboot, cannot tell, failed its updates or carries other servers", async () => {
        const no = fakeHost({ output: "[shellmind] reboot-required=no\n" });
        await step(no);
        // "reboot-required=no" says it all: nothing is added.
        expect(no.text()).toBe("[shellmind] reboot-required=no\n");
        const unknown = fakeHost({ output: "[shellmind] reboot-re" + "quired=unknown" });
        await step(unknown);
        expect(unknown.text()).toContain("[shellmind] reboot=skip-unknown\n");
        const failed = fakeHost({ exitCode: 100 });
        await expect(step(failed)).resolves.toEqual({ code: 100, signal: null });
        const jump = fakeHost();
        await step(jump, { jumpHosts: [3] });
        expect(jump.text()).toContain("[shellmind] reboot=skip-jump-host\n");
        for (const host of [no, unknown, failed, jump]) expect(host.closed).toEqual([]);
    });

    it("reboots, waits for SSH with backoff and reports the new boot", async () => {
        const host = fakeHost({ downMs: 45_000 });
        const outcome = await step(host);
        expect(outcome.code).toBe(0);
        expect(outcome.lease).toBe(host.leases.at(-1));
        expect(outcome.lease).not.toBe(host.context.lease);
        expect(host.closed).toEqual([3]);
        expect(host.text()).toMatch(/\n\[shellmind\] reboot=start\n\[shellmind\] reboot=waiting\n\[shellmind\] reboot=still-waiting after=\d+\n\[shellmind\] reboot=back after=\d+ up=\d+ state=running failed=0\n$/);
        // Failed attempts gave their leases back; the one it returns is not.
        expect(host.leases.slice(1, -1).every((lease) => lease.released)).toBe(true);
        expect(host.leases.at(-1)!.released).toBe(false);
        expect(host.audit).toEqual([expect.objectContaining({
            serverId: 3, source: "ops", command: "reboot (patch center)", exitCode: 0,
            meta: expect.objectContaining({ jobId: "job-1", patch: true, action: "reboot", state: "running", failedUnits: 0, backAfterSec: expect.any(Number) })
        })]);
        // CR-01: written before the reboot was sent, then completed; a backend
        // that stops while the server is down leaves that first entry.
        expect(host.sent).toEqual([{ serverId: 3, source: "ops", command: "reboot (patch center)", exitCode: null, meta: { jobId: "job-1", servers: 1, patch: true, action: "reboot", status: "running" } }]);
        expect(host.audit[0].meta).not.toHaveProperty("status");
        // CR-04: the fleet board knows of the reboot, for as long as it may take.
        expect(host.maintenance).toEqual([{ serverId: 3, until: 20_000 + 600_000 + 120_000 }, { serverId: 3, until: null }]);
    });

    it("completes the reboot's audit entry when the run is cancelled while the server is down", async () => {
        const host = fakeHost({ downMs: 600_000 });
        const controller = new AbortController();
        const running = createPatchStep({ script: "run", reboot: true, rebootWaitMs: 600_000, jumpHosts: new Set() }, {
            ...host.deps,
            sleep: async (ms) => {
                await host.deps.sleep(ms, controller.signal);
                controller.abort();
            }
        })({ ...host.context, signal: controller.signal });
        await expect(running).rejects.toThrow();
        expect(host.audit).toHaveLength(1);
        expect(host.audit[0]).toMatchObject({ exitCode: null, meta: { action: "reboot", error: expect.stringMatching(/reboot-failed=cancelled|abort/i) } });
    });

    it("counts a container's restart (same kernel, a new PID 1) as a reboot", async () => {
        const host = fakeHost({ downMs: 5000, after: { bootId: "boot-1", pid1: "9000000", uptime: 90_030, state: null } });
        const outcome = await step(host);
        expect(outcome.code).toBe(0);
        expect(host.text()).toMatch(/\[shellmind\] reboot=back after=\d+ up=\d+\n$/);
    });

    it("waits for systemd to finish starting", async () => {
        const host = fakeHost({ downMs: 1000, settling: ["starting", "starting", "running"] });
        const outcome = await step(host);
        expect(outcome.code).toBe(0);
        expect(host.text()).toContain("state=running");
    });

    it("fails a server that comes back with more failed units, or broken", async () => {
        const degraded = fakeHost({ downMs: 1000, after: { state: "degraded", failed: 2 } });
        expect((await step(degraded)).code).toBe(1);
        expect(degraded.errors()).toBe("[shellmind] reboot-check=failed-units before=0 after=2\n");
        const already = fakeHost({ downMs: 1000, before: { state: "degraded", failed: 1 }, after: { state: "degraded", failed: 1 } });
        expect((await step(already)).code).toBe(0);
        const broken = fakeHost({ downMs: 1000, after: { state: "maintenance" } });
        expect((await step(broken)).code).toBe(1);
        expect(broken.errors()).toBe("[shellmind] reboot-check=state state=maintenance\n");
    });

    it("gives up when SSH does not come back in time", async () => {
        const host = fakeHost({ downMs: 10 * 60_000 });
        await expect(step(host, { rebootWaitMs: 120_000 })).rejects.toThrow(/^\[shellmind\] reboot-failed=timeout wait=120 \| connect ECONNREFUSED/);
        expect(host.clock() - 1_000_000).toBeLessThanOrEqual(125_000);
        expect(host.audit).toEqual([expect.objectContaining({ exitCode: null, meta: expect.objectContaining({ action: "reboot", error: expect.stringMatching(/reboot-failed=timeout/) }) })]);
    });

    it("waits through logins refused while the host shuts down and boots (pam_nologin)", async () => {
        const host = fakeHost({ downMs: 0, refusedLogins: 3 });
        const outcome = await step(host);
        expect(outcome.code).toBe(0);
        expect(host.text()).toContain("[shellmind] reboot=back after=");
    });

    it("gives up when the login keeps being refused after the reboot, and at once on a changed host key", async () => {
        const refused = fakeHost({ downMs: 0, connectError: Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" }) });
        await expect(step(refused)).rejects.toThrow(/^\[shellmind\] reboot-failed=connection \| Auth failed/);
        expect(refused.clock() - 1_000_000).toBeLessThan(120_000);
        const changed = fakeHost({ downMs: 0, connectError: new HostKeyMismatchError("10.0.0.3", 22, "ssh-ed25519", "SHA256:a", "SHA256:b") });
        await expect(step(changed)).rejects.toThrow(/^\[shellmind\] reboot-failed=connection \| /);
        expect(changed.clock() - 1_000_000).toBeLessThan(10_000);
    });

    it("reports a server that never went down", async () => {
        const host = fakeHost({ noReboot: true });
        await expect(step(host)).rejects.toThrow(/^\[shellmind\] reboot-failed=same-boot after=300$/);
    });

    it("reports a reboot command that failed (no privilege)", async () => {
        const host = fakeHost({ rebootReply: { code: 77, stderr: "[shellmind] error=reboot-privilege\n" } });
        await expect(step(host)).resolves.toEqual({ code: 77, signal: null });
        expect(host.errors()).toBe("[shellmind] reboot-failed=command code=77\n[shellmind] error=reboot-privilege\n");
        expect(host.closed).toEqual([]);
        expect(host.audit[0]).toMatchObject({ exitCode: 77, meta: { action: "reboot", error: "[shellmind] error=reboot-privilege" } });
    });

    it("does not reboot a server whose boots cannot be told apart", async () => {
        const host = fakeHost({ before: { bootId: "", pid1: "" } });
        const run = vi.spyOn(host.deps, "run");
        await expect(step(host)).resolves.toEqual({ code: 0, signal: null });
        expect(run.mock.calls.map(([, script]) => script)).toEqual([BOOT_CHECK_SCRIPT]);
        expect(host.text()).toContain("[shellmind] reboot=skip-no-boot-id\n");
    });
});

describe("boot states", () => {
    it("reads the boot check and tells boots apart", () => {
        const state = parseBootState("@@SM:boot\nabc\n@@SM:pid1\n1500\n@@SM:hz\n100\n@@SM:uptime\n120.50\n@@SM:state\ndegraded\n@@SM:failed\n2\n@@SM:end\n");
        expect(state).toEqual({ bootId: "abc", pid1: "1500", hz: 100, uptimeSec: 120.5, state: "degraded", failed: 2 });
        expect(upSeconds(state)).toBe(106);
        expect(parseBootState("@@SM:boot\n\n@@SM:end\n")).toEqual({ bootId: null, pid1: null, hz: 100, uptimeSec: null, state: null, failed: null });
        expect(bootedAgain(state, { ...state, bootId: "def" })).toBe(true);
        expect(bootedAgain(state, { ...state, pid1: "99" })).toBe(true);
        expect(bootedAgain(state, state)).toBe(false);
    });
});
