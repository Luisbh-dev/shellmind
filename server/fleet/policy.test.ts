import { describe, expect, it } from "vitest";
import { ConnectionTargetError } from "../connections/target";
import { ExecTimeoutError } from "../ssh/exec";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { ALERT_CONFIRMATIONS, awaitsConfirmation, classifyFailure, FLEET_TIMING, jittered, observeState, retryDelay, type AlertTrack } from "./policy";
import { ProbeError } from "./probe";

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("failed checks", () => {
    it("holds rejected credentials and changed host keys instead of retrying them", () => {
        const auth = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
        expect(classifyFailure(new ProbeError("connect", auth))).toMatchObject({ state: "error", hold: "auth", error: { code: "AUTH_FAILED" } });

        const key = new ProbeError("connect", new HostKeyMismatchError("10.0.0.5", 22, "ssh-ed25519", "SHA256:old", "SHA256:new", "bastion:22"));
        expect(classifyFailure(key)).toMatchObject({
            state: "error",
            hold: "host-key",
            error: { code: "HOST_KEY_MISMATCH" },
            hostKey: { host: "10.0.0.5", port: 22, via: "bastion:22", actual: "SHA256:new" }
        });

        const passphrase = new ProbeError("connect", new Error("Encrypted private OpenSSH key detected, but no passphrase given"));
        expect(classifyFailure(passphrase)).toMatchObject({ hold: "auth", error: { code: "PRIVATE_KEY_INVALID" } });

        const unreadable = new ProbeError("connect", new ConnectionTargetError("SECRET_UNREADABLE", "cannot be decrypted"));
        expect(classifyFailure(unreadable)).toMatchObject({ state: "error", hold: "config", error: { code: "SECRET_UNREADABLE" } });
    });

    // W7 integration: the sign-in failures of identities and the SSH agent (S2).
    it("holds a sign-in the SSH agent could not do, and an identity or agent that is missing", () => {
        const agentFailed = Object.assign(new Error("Auth failed: the SSH agent could not be used (Pageant is not running)."), { code: "AGENT_FAILED", details: { reason: "Pageant is not running" } });
        expect(classifyFailure(new ProbeError("connect", agentFailed))).toMatchObject({ state: "error", hold: "auth", error: { code: "AGENT_FAILED" } });
        expect(classifyFailure(new ProbeError("connect", new ConnectionTargetError("AGENT_UNAVAILABLE", "no agent")))).toMatchObject({ state: "error", hold: "config", error: { code: "AGENT_UNAVAILABLE" } });
        expect(classifyFailure(new ProbeError("connect", new ConnectionTargetError("IDENTITY", "identity gone")))).toMatchObject({ state: "error", hold: "config", error: { code: "IDENTITY" } });
    });

    it("calls a connection that could not be made unreachable, and retries it", () => {
        for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND", "JUMP_UNREACHABLE"]) {
            expect(classifyFailure(new ProbeError("connect", coded(code))), code).toMatchObject({ state: "unreachable", hold: null, error: { code } });
        }
        const timeout = Object.assign(new Error("Timed out while waiting for handshake"), { level: "client-timeout" });
        expect(classifyFailure(new ProbeError("connect", timeout))).toMatchObject({ state: "unreachable", error: { code: "HANDSHAKE_TIMEOUT" } });
    });

    it("calls a check that failed on a reached server an error", () => {
        expect(classifyFailure(new ProbeError("run", new ExecTimeoutError("sh -s", 30_000)))).toMatchObject({ state: "error", hold: null, error: { code: "EXEC_TIMEOUT" } });
    });

    it("keeps the message short", () => {
        const long = classifyFailure(new ProbeError("connect", coded("ECONNRESET", "x".repeat(5000))));
        expect(long.error.message).toHaveLength(500);
    });
});

describe("retry timing", () => {
    it("confirms a first failure soon, then backs off from the interval up to an hour", () => {
        const five = 5 * 60_000;
        expect([1, 2, 3, 4, 5, 6, 7, 8].map((failures) => retryDelay(five, failures) / 60_000)).toEqual([1, 5, 10, 20, 40, 60, 60, 60]);
        // A short interval needs no quicker confirmation.
        expect(retryDelay(30_000, 1)).toBe(30_000);
        // An interval longer than an hour caps at itself.
        expect(retryDelay(2 * 60 * 60_000, 9)).toBe(2 * 60 * 60_000);
    });

    it("spreads each delay by at most ±10%", () => {
        expect(jittered(100_000, () => 0)).toBe(90_000);
        expect(jittered(100_000, () => 1)).toBe(110_000);
        expect(jittered(100_000, () => 0.5)).toBe(100_000);
        expect(FLEET_TIMING.jitter).toBe(0.1);
    });
});

describe("alerts", () => {
    const start: AlertTrack = { state: null, streak: 0, before: null, alerted: null };
    const run = (states: Array<Parameters<typeof observeState>[1]>) => {
        let track = start;
        const alerts: Array<{ at: number; state: string; previous: string | null }> = [];
        states.forEach((state, index) => {
            const result = observeState(track, state);
            track = result.track;
            if (result.alert) alerts.push({ at: index, ...result.alert });
        });
        return { track, alerts };
    };

    it("raises one alert once a second check confirms the state", () => {
        expect(ALERT_CONFIRMATIONS).toBe(2);
        const { alerts } = run(["ok", "critical", "critical", "critical", "critical"]);
        expect(alerts).toEqual([{ at: 2, state: "critical", previous: "ok" }]);
    });

    it("raises none for a single bad reading", () => {
        expect(run(["ok", "unreachable", "ok", "critical", "warn"]).alerts).toEqual([]);
    });

    it("raises again after the server recovered, and for a different alert state", () => {
        const { alerts } = run(["unreachable", "unreachable", "ok", "unreachable", "unreachable", "critical", "critical"]);
        expect(alerts.map((alert) => [alert.at, alert.state])).toEqual([[1, "unreachable"], [4, "unreachable"], [6, "critical"]]);
        expect(alerts[2].previous).toBe("unreachable");
    });

    it("asks for a quick confirmation only while an alert is pending", () => {
        expect(awaitsConfirmation(observeState(start, "critical").track)).toBe(true);
        expect(awaitsConfirmation(run(["critical", "critical"]).track)).toBe(false);
        expect(awaitsConfirmation(observeState(start, "warn").track)).toBe(false);
        expect(awaitsConfirmation(observeState(start, "error").track)).toBe(false);
    });
});
