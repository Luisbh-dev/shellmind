export default {
    starting: 'Starting backend…',
    waiting: 'Still waiting for the backend at {url}…',
    retryNow: 'Retry now',
    blocked: 'The backend refused this page: {reason}.',
    blockedHint: 'When ShellMind is reached through a domain name or another address, add it to ALLOWED_ORIGINS (or ALLOWED_HOSTS) on the server.',
    title: 'Access token required',
    description: 'This ShellMind server only accepts requests with its access token. The server prints it at startup ("Access token: …") unless it was set with SHELLMIND_AUTH_TOKEN.',
    tokenLabel: 'Access token',
    tokenPlaceholder: 'Paste the access token',
    remember: 'Remember on this device',
    rememberHint: 'Stored in this browser. Leave unchecked on shared computers.',
    submit: 'Unlock',
    rejected: 'That token was not accepted.',
    expired: 'The access token is no longer valid. Enter the current one.',
    failed: 'Could not verify the token: {message}',
    locked: 'ShellMind is locked',
    keptHint: 'Everything you had open stays as it is behind this window and continues once you unlock.'
};
