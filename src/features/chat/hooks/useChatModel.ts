import { useEffect } from 'react';
import { create } from 'zustand';
import { DEFAULT_MODEL, resolveModelId } from '@shared/models';
import { api } from '@/lib/api';

// The chat model is one app-wide setting (GET/POST /api/config/model). Every
// open server keeps its chat mounted, and all of them show, and send with,
// this one choice: picking a model in one chat picks it in the others.
const useChatModelStore = create<{ model: string }>(() => ({ model: DEFAULT_MODEL }));

// Bumped by every choice made here, so that a read of the saved model that
// started before it never overwrites it.
let choices = 0;
let reading: Promise<void> | null = null;

function readSavedModel(): Promise<void> {
    if (reading) return reading;
    const started = choices;
    reading = api.get<{ model?: string }>('/api/config/model')
        .then((data) => {
            if (data?.model && started === choices) useChatModelStore.setState({ model: resolveModelId(data.model) });
        }, () => undefined)
        .finally(() => {
            reading = null;
        });
    return reading;
}

// The model of every chat. The saved one is read when a chat mounts (once for
// the chats that mount together).
export function useChatModel(): string {
    useEffect(() => {
        void readSavedModel();
    }, []);
    return useChatModelStore((state) => state.model);
}

// Picks `model` for every chat; saving it is up to the caller.
export function chooseChatModel(model: string): void {
    choices += 1;
    useChatModelStore.setState({ model });
}
