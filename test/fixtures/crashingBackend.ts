// Forked by startup-ipc.test.ts: the backend's crash policy facing an
// unhandled rejection (logged, the process carries on) and then a bug that
// throws outside any handler, as a socket or SSH callback would.
import { installCrashHandlers } from "../../server/lifecycle";

installCrashHandlers();

void Promise.reject(new Error("ignored rejection"));

setTimeout(() => {
    throw new Error("boom");
}, 200);
