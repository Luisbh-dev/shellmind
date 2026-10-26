import { useEffect, useRef } from 'react';
import { Stethoscope } from 'lucide-react';
import { askAi } from '@/components/AskAiButton';
import { useT } from '@/i18n';
import type { GlobalAction, GlobalActionProps } from './types';

// The triage pack from the command palette: runs once and closes. The chat
// of the active server opens with the pack attached (failed units, errors of
// the last hour, disk, memory, processes, listening ports), collected by the
// backend and shown before anything is sent to the AI.
function Triage({ onClose, server }: GlobalActionProps) {
    const t = useT();
    const done = useRef(false);
    useEffect(() => {
        if (done.current) return;
        done.current = true;
        if (server) askAi(t, server.id, { kind: 'triage' });
        onClose();
    }, [server, onClose, t]);
    return null;
}

const triageAction: GlobalAction = {
    id: 'triage',
    order: 70,
    labelKey: 'chat.diagnose.triageAction',
    icon: Stethoscope,
    placement: 'palette',
    requiresServer: true,
    // SSH-capable hosts, like the status and operations tabs.
    isAvailable: (server) => server !== null && !['ftp', 's3', 'local'].includes(server.type),
    Component: Triage
};

export default triageAction;
