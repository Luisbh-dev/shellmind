export default {
    title: 'Settings',
    sectionsLabel: 'Settings sections',
    sections: {
        general: 'General',
        appearance: 'Appearance',
        ai: 'AI',
        keychain: 'Keychain',
        data: 'Data',
        about: 'About'
    },
    retry: 'Try again',
    language: {
        heading: 'Language',
        description: 'Language used by the interface.',
        system: 'System default ({language})'
    },
    shortcuts: {
        heading: 'Keyboard shortcuts'
    },
    ai: {
        heading: 'AI providers',
        checking: 'Checking providers...',
        statusUnavailable: 'Could not check the AI configuration',
        notConfigured: 'Not configured',
        configured: 'Configured ({source})',
        proxyManaged: 'Proxy managed',
        proxyWithKey: 'Proxy + your key ({source})',
        source: {
            env: 'Environment',
            db: 'Database'
        },
        minimaxViaProxy: 'MiniMax requests go through the ShellMind proxy before reaching MiniMax, as described in the {legal}. Your prompts and the terminal context you share pass through it.',
        minimaxDirect: 'With your own key, MiniMax requests go straight from the ShellMind backend to MiniMax; the ShellMind proxy is not used.',
        legalLink: 'legal notice',
        geminiDisclosure: 'Gemini requests go straight from the ShellMind backend to Google.',
        minimaxClientKeyAllowed: 'You can optionally attach your own MiniMax key.',
        minimaxClientKeyDirect: 'Add your own MiniMax key to send requests straight to MiniMax instead.',
        minimaxClientKeyDisabled: 'Your own MiniMax keys are disabled by the proxy policy.',
        lockedByEnv: 'Managed via environment variables. Cannot be changed here.',
        savingDisabled: 'Saving {provider} keys from the app is disabled for this configuration.',
        help: {
            gemini: 'Get your key from Google AI Studio.',
            minimax: 'Optional: bring your own key.'
        },
        openPortal: 'Open portal',
        keyLabel: '{provider} API key',
        keyPlaceholderSaved: 'Saved. Enter a new key to replace it',
        delete: 'Delete',
        saveKey: 'Save key',
        updateKey: 'Update key',
        saved: '{provider} key saved',
        saveFailed: 'Could not save key',
        saveError: 'Failed to save key',
        deleteDialog: {
            title: 'Delete API key',
            message: 'Delete the saved {provider} API key from this app? Environment variable keys are not affected.',
            confirm: 'Delete key'
        },
        deleted: '{provider} key deleted',
        deleteFailed: 'Could not delete key',
        deleteError: 'Failed to delete key'
    },
    data: {
        encryptedTitle: 'Credentials are encrypted at rest',
        encryptedBody: 'Passwords, private keys, passphrases, S3 secrets and API keys are stored encrypted (AES-256-GCM). The data key lives next to the database, protected by the operating system keychain in the desktop app. They never leave the backend and are never exported.'
    },
    about: {
        version: 'Version {version}',
        backendVersion: 'Backend version {version}',
        description: 'The self-hosted workspace for sysadmins and DevOps: SSH terminals, files, operations, fleet health, Remote Desktop and an AI assistant.',
        license: 'Open source under the MIT license.',
        source: 'Source code on GitHub'
    }
};
