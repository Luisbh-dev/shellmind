import { clearBackendEnv } from './backendEnv';

// Every node test file starts from a backend environment without the
// developer's settings: tests that import server/ modules directly (not only
// through bootTestServer) and the processes they spawn see the defaults.
clearBackendEnv();
