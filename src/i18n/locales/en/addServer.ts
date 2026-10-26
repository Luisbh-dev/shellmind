export default {
    newTitle: 'New connection',
    editTitle: 'Edit connection',
    newDescription: 'Configure how ShellMind connects to your host',
    editDescription: 'Update the connection details',
    add: 'Add connection',
    saveChanges: 'Save changes',
    added: 'Connection added',
    updated: 'Connection updated',
    typeLabel: 'Type',
    organization: 'Organization',
    types: {
        linux: { label: 'SSH / Linux', hint: 'Linux and Unix shells over SSH.' },
        windows: { label: 'Windows', hint: 'Windows over OpenSSH (terminal, files, status) and RDP.' },
        ftp: { label: 'FTP', hint: 'File transfer over FTP, optionally encrypted (FTPS).' },
        s3: { label: 'S3', hint: 'S3-compatible object storage (AWS, MinIO, R2…).' },
        local: { label: 'Local CLI', hint: 'Local command-line tools (Azure, AWS, kubectl…) in a real terminal.' }
    },
    namePlaceholder: {
        linux: 'e.g. Production DB',
        windows: 'e.g. Domain controller',
        ftp: 'e.g. Web uploads',
        s3: 'e.g. Backups bucket',
        local: 'e.g. Azure (work)'
    },
    presets: {
        shell: { label: 'System shell', note: 'Full local shell (PowerShell / bash).' },
        azure: { label: 'Azure CLI', note: 'Scoped "az>" console (only az subcommands). Requires the Azure CLI.' },
        aws: { label: 'AWS CLI', note: 'Scoped "aws>" console (only aws subcommands). Requires the AWS CLI.' },
        gcloud: { label: 'Google Cloud', note: 'Scoped "gcloud>" console. Requires the gcloud CLI.' },
        kubectl: { label: 'Kubernetes', note: 'Scoped "kubectl>" console. Requires kubectl.' },
        docker: { label: 'Docker', note: 'Scoped "docker>" console (only docker subcommands). Requires Docker.' },
        custom: { label: 'Custom command', note: 'Full shell launching a specific program (e.g. "wsl -d Ubuntu").' }
    },
    fields: {
        name: 'Display name',
        cliPreset: 'CLI preset',
        command: 'Command',
        initialCommand: 'Run on connect',
        cwd: 'Working directory',
        host: 'Host / IP',
        sshPort: 'SSH port',
        rdpPort: 'RDP port',
        ftpPort: 'FTP port',
        openSshPort: 'OpenSSH port',
        domain: 'Domain',
        username: 'Username',
        auth: 'Authentication',
        password: 'Password',
        windowsPassword: 'Password (RDP / SSH)',
        privateKey: 'Private key (PEM / OpenSSH)',
        keyPath: 'Private key file',
        passphrase: 'Key passphrase',
        ftpSecure: 'Encrypt the connection (FTPS)',
        jumpHost: 'Jump host',
        provider: 'Provider',
        bucket: 'Bucket',
        region: 'Region',
        endpoint: 'Endpoint URL',
        accessKey: 'Access key',
        secretKey: 'Secret key',
        group: 'Group',
        color: 'Color',
        tags: 'Tags',
        notes: 'Notes'
    },
    hints: {
        command: 'Program to launch. Leave it empty for the system shell.',
        initialCommand: 'Optional. Runs automatically when the session opens.',
        cwd: 'Your home directory when empty',
        domain: 'Optional. Windows logon domain for Remote Desktop.',
        windowsSsh: 'The terminal, files and status use OpenSSH Server on Windows.',
        windowsPasswordWithKey: 'Used for Remote Desktop; SSH signs in with the key.',
        keyPath: 'Read on the machine running ShellMind each time it connects. ~ is your home directory.',
        passphrase: 'Only if the key is encrypted',
        passwordPlaceholder: 'Password for this user',
        s3SecretPlaceholder: 'Secret of the access key',
        ftpSecure: 'Explicit TLS (AUTH TLS). Turn it off only for servers without TLS: the password would travel in clear text.',
        jumpHost: 'Connect through another saved SSH server (ProxyJump).',
        group: 'e.g. Production',
        tags: 'Press Enter or comma to add a tag.'
    },
    auth: {
        password: 'Password',
        key: 'Private key',
        keyFile: 'Key file'
    },
    jump: {
        none: 'None (direct connection)'
    },
    s3: {
        aws: 'AWS S3',
        other: 'Other (MinIO, R2…)'
    },
    secrets: {
        password: 'password',
        privateKey: 'private key',
        passphrase: 'key passphrase',
        s3_secret_key: 'S3 secret key',
        identity: 'identity credentials',
        saved: 'Saved',
        willRemove: 'Removed on save',
        remove: 'Remove',
        removeLabel: 'Remove the saved {secret}',
        undoRemoveLabel: 'Keep the saved {secret}',
        keepPlaceholder: 'Leave blank to keep the saved one',
        clearNotice: 'Saving deletes the stored {secrets}.'
    },
    retarget: {
        title: 'Keep the saved credentials?',
        message: 'This change points the connection somewhere else (or turns off encryption). Send the saved {secrets} to the new target?',
        keep: 'Keep and save',
        cancel: 'Go back',
        declined: 'Not saved. Enter the credentials again, or remove the saved ones, to save this change.'
    },
    identity: {
        label: 'Credentials',
        hint: 'Sign in with a saved identity (Settings › Keychain) or with this server\'s own credentials.',
        own: 'This server\'s own',
        ownHint: 'Password or key saved on this server only',
        usernameFromIdentity: 'Optional: "{username}" from the identity when empty.',
        usernameDefault: 'Optional: root when empty.',
        signsInWith: 'Signs in with "{name}":',
        windowsRdp: 'The identity\'s password is also used for Remote Desktop.',
        windowsNoRdp: 'This identity has no password, so this server will have none saved for Remote Desktop.',
        keepOwn: 'Also keep this server\'s own password or key',
        keepOwnHint: 'They are tried first. Leave it off to remove them and use only the identity.'
    },
    agentForward: {
        label: 'Forward the SSH agent to terminals',
        hint: 'Lets programs on this server (git, ssh) use your agent\'s keys while a terminal is open, until the connection closes. Anyone with root on the server can use them too: only for servers you trust.',
        needsAgent: 'Only works with an identity that signs in with the SSH agent.'
    },
    discard: {
        title: 'Discard changes?',
        message: 'The changes to this connection have not been saved.',
        confirm: 'Discard',
        cancel: 'Keep editing'
    },
    errors: {
        nameRequired: 'Enter a name.',
        unknownPreset: 'ShellMind does not know this CLI preset (it was saved by an older version). Choose one from the list.',
        hostRequired: 'Enter the host name or IP address.',
        port: 'Use a port between 1 and 65535, or leave it empty for the default.',
        usernameRequired: 'Enter the user name.',
        keyRequired: 'Paste the private key.',
        keyPathRequired: 'Enter the path of the key file.',
        bucketRequired: 'Enter the bucket name.',
        endpointRequired: 'Enter the endpoint URL.',
        accessKeyRequired: 'Enter the access key.',
        secretRequired: 'Enter the secret key.',
        backend: 'Could not reach the ShellMind backend. Is it running?'
    }
};
