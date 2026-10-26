import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createAutoRun, type AutoRunController, type AutoRunDeps } from '../lib/autoRun';

// The Auto-Run controller of one chat (one server). Dependencies are read
// through a ref, so the controller always sees the latest props while its
// timers and chain state survive re-renders. Unmounting (a server switch)
// disposes it: nothing it started can run afterwards. The panel stays mounted
// while the chat is closed; ChatPanel turns Auto-Run off then.
export function useAutoRun(deps: AutoRunDeps) {
    const depsRef = useRef(deps);
    useEffect(() => {
        depsRef.current = deps;
    });

    const [controller] = useState<AutoRunController>(() => createAutoRun({
        runnableCommands: (answer, complete) => depsRef.current.runnableCommands(answer, complete),
        scopedBin: () => depsRef.current.scopedBin(),
        isConnected: () => depsRef.current.isConnected(),
        run: (command) => depsRef.current.run(command),
        outputMark: () => depsRef.current.outputMark(),
        readOutputSince: (mark) => depsRef.current.readOutputSince(mark),
        outputSession: () => depsRef.current.outputSession?.() ?? null,
        analyze: (output) => depsRef.current.analyze(output),
        notify: (notice) => depsRef.current.notify(notice),
        maxSteps: deps.maxSteps,
        timing: deps.timing
    }));

    useEffect(() => () => controller.dispose(), [controller]);

    const state = useSyncExternalStore(controller.subscribe, controller.getState);
    return { controller, state };
}
