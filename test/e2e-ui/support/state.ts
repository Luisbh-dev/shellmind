// What the global setup started, handed to the specs (worker processes)
// through one environment variable.

export const STATE_VARIABLE = 'SHELLMIND_E2E_UI_STATE';

export type HostName = 'alpha' | 'beta' | 'rekey' | 'dind';

export type Host = {
    container: string;
    port: number;
};

export type E2EState = {
    webUrl: string;
    apiUrl: string;
    token: string;
    aiMockUrl: string;
    hosts: Record<HostName, Host>;
};

export function readState(): E2EState {
    const raw = process.env[STATE_VARIABLE];
    if (!raw) throw new Error('The end-to-end UI suite runs through `npm run test:e2e-ui` (its global setup starts the app).');
    return JSON.parse(raw) as E2EState;
}

export const enabled = () => process.env.SHELLMIND_E2E_UI === '1';
