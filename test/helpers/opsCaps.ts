import type { OpsCapabilities } from "../../shared/ops";

// Capabilities for unit tests of the command builders.
export function testCaps(overrides: Partial<Omit<OpsCapabilities, "containers">> & { containers?: Partial<OpsCapabilities["containers"]> } = {}): OpsCapabilities {
    const { containers, ...rest } = overrides;
    return {
        platform: "linux",
        root: true,
        sudo: false,
        systemd: true,
        journal: true,
        detectedAt: 0,
        ...rest,
        containers: { engine: "docker", version: "26.1.4", sudo: false, compose: true, problem: null, ...containers }
    };
}
