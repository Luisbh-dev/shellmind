import { clearBackendEnv } from '../../setup/backendEnv';

// Entry of the backend process the suite starts (node --import tsx): the
// developer's backend settings and .env are cleared, the run's own applied,
// then the real server.ts starts as `npm start` runs it.
const settings = JSON.parse(process.env.SHELLMIND_E2E_UI_BACKEND_ENV ?? '{}') as Record<string, string>;
delete process.env.SHELLMIND_E2E_UI_BACKEND_ENV;
clearBackendEnv();
Object.assign(process.env, settings);
void import('../../../server');
