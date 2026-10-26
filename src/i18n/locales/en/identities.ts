export default {
    title: 'Identities',
    description: 'Credentials several servers share: a username with a password, a key or the SSH agent. Change them here once instead of on every server.',
    generate: 'Generate key',
    new: 'New identity',
    loading: 'Loading identities…',
    loadFailed: 'Could not load the identities.',
    retry: 'Retry',
    listLabel: 'Saved identities',
    saved: '"{name}" saved',
    created: '"{name}" created',
    empty: {
        title: 'No identities yet',
        description: 'Create one for credentials you use on several servers, or generate a new ed25519 key and install it on them.'
    },
    credentials: {
        password: 'Password',
        key: 'Key',
        keyOfType: 'Key ({type})',
        keyFile: 'Key file',
        agent: 'SSH agent',
        none: 'No credentials'
    },
    secrets: {
        password: 'password',
        passphrase: 'passphrase'
    },
    card: {
        user: 'User',
        noUser: 'Servers keep their own username',
        unused: 'Not used yet',
        usedBy: {
            one: 'Used by 1 server',
            other: 'Used by {count} servers'
        },
        keyFile: 'Reads',
        showKey: 'Show the public key',
        hideKey: 'Hide the public key'
    },
    actions: {
        install: 'Install key',
        installLabel: 'Install key: {name}',
        edit: 'Edit',
        editLabel: 'Edit {name}',
        more: 'More actions for {name}',
        assign: 'Use on servers…',
        rotate: 'Rotate key…',
        delete: 'Delete'
    },
    delete: {
        title: 'Delete identity',
        message: 'Delete "{name}" and its saved password and key? This cannot be undone.',
        confirm: 'Delete',
        done: '"{name}" deleted',
        inUse: '"{name}" is still used by these servers. Assign them another identity first:',
        failed: 'Could not delete the identity'
    },
    errors: {
        backend: 'Could not reach the ShellMind backend. Is it running?'
    },
    publicKey: {
        copied: 'Public key copied',
        copyFailed: 'Could not copy the public key',
        copyLabel: 'Copy the public key of {name}'
    },
    picker: {
        noServers: 'There are no SSH servers yet.',
        search: 'Search servers',
        group: 'Group',
        allGroups: 'All groups',
        noGroup: 'No group',
        tag: 'Tag',
        allTags: 'All tags',
        selected: '{count} of {total} selected',
        selectShown: 'Select shown ({count})',
        clear: 'Clear',
        noMatches: 'No server matches.',
        usesIdentity: 'Uses {name}'
    },
    install: {
        title: 'Install the key of {name}',
        description: 'Adds the public key to authorized_keys of each server\'s user, signing in with the server\'s current credentials, then checks that the key alone signs in.',
        serversLabel: 'Servers to install the key on',
        progressLabel: 'Progress per server',
        start: {
            one: 'Install on 1 server',
            other: 'Install on {count} servers'
        },
        stop: 'Stop',
        close: 'Done',
        useIdentity: {
            one: 'Use {name} on that server',
            other: 'Use {name} on those {count} servers'
        },
        useIdentityHint: 'The key now signs in to servers that do not use "{name}" yet. Switch them to it to stop depending on their own password.',
        phase: {
            waiting: 'Waiting',
            installing: 'Adding the key…',
            verifying: 'Checking sign-in…'
        },
        outcome: {
            installed: 'Installed · signs in',
            present: 'Already there · signs in',
            unverified: 'Added, but the key alone did not sign in',
            failed: 'Failed',
            cancelled: 'Cancelled'
        },
        notAccepted: 'sshd did not accept the key on its own: check AuthorizedKeysFile and StrictModes in its sshd_config, and the permissions of the home directory.',
        warnings: {
            homeWritable: 'The home directory is writable by other users: sshd (StrictModes) ignores keys until that is fixed (chmod go-w ~).',
            other: 'The server reported a problem with its SSH files.'
        },
        summary: {
            installed: '{count} installed',
            present: '{count} already there',
            unverified: '{count} not signing in',
            failed: '{count} failed',
            cancelled: '{count} cancelled',
            nothing: 'Nothing was done.',
            running: '{done} of {total} done'
        }
    },
    rotate: {
        title: 'Rotate the key of {name}',
        description: 'Replaces the stored key with a new ed25519 key without locking anyone out.',
        steps: {
            one: 'A new key is generated and installed on the server that uses this identity, signing in with the current key. Only when it signs in with the new key is the stored key replaced.',
            other: 'A new key is generated and installed on the {count} servers that use this identity, signing in with the current key. Only when every one of them signs in with the new key is the stored key replaced.'
        },
        noServers: 'No server uses this identity: the key is replaced right away.',
        oldKeyNote: 'The previous key stays in their authorized_keys (other people or tools may rely on it); remove it there when it is no longer needed.',
        removeOld: 'Remove the previous key from these servers',
        removeOldHint: 'Once every server signs in with the new key, the previous one is taken out of their authorized_keys, so a copy of it (a leaked key, a lost laptop) stops working. Untick it if other people or tools still sign in with it.',
        removal: {
            removed: 'Previous key removed',
            absent: 'Previous key was not there',
            failed: 'The previous key could not be removed: it still signs in here.',
            keptOne: 'The previous key is still in the authorized_keys of 1 server: remove it there by hand.',
            keptOther: 'The previous key is still in the authorized_keys of {count} servers: remove it there by hand.'
        },
        passphrase: 'Passphrase of the new key',
        passphraseHint: 'Optional. Leave it blank to keep the current one.',
        keepPassphrase: 'Leave blank to keep the current passphrase',
        noPassphrase: 'Store the new key without a passphrase',
        noPassphraseHint: 'It is still stored encrypted with ShellMind\'s data key.',
        force: 'Replace the key even if some servers fail',
        forceHint: 'Those servers will need another credential (a password) to sign in.',
        start: 'Rotate key',
        replaced: 'Key rotated. New fingerprint:',
        notReplaced: 'The key was not replaced: {count} server(s) did not take the new key. Fix them and rotate again.',
        cancelled: 'Rotation cancelled: the key was not replaced.'
    },
    assign: {
        title: 'Use {name} on servers',
        description: 'The ticked servers sign in with this identity; unticked ones stop using it and sign in with their own credentials only.',
        serversLabel: 'Servers that use the identity',
        clearOwn: 'Remove the own password and key of newly added servers',
        clearOwnHint: {
            one: '1 of them has its own credentials, which would otherwise win over the identity\'s.',
            other: '{count} of them have their own credentials, which would otherwise win over the identity\'s.'
        },
        clearOwnHintNone: 'Credentials saved on a server win over the identity\'s.',
        windowsNote: 'This identity has no password: Windows servers would have none left for Remote Desktop.',
        uncheckedNote: 'ShellMind has not checked that "{name}" signs in to {servers}. If it does not, they cannot sign in once their own credentials are removed.',
        leftWithout: {
            one: '{servers} has no password or key of its own: once it stops using this identity it cannot sign in until you edit it or give it another identity.',
            other: '{servers} have no password or key of their own: once they stop using this identity they cannot sign in until you edit them or give them another identity.'
        },
        confirm: {
            title: 'Remove their own credentials?',
            message: 'The saved password and key of these servers will be deleted. From now on they sign in only with "{name}":',
            unchecked: 'Not checked: ShellMind has not verified that "{name}" signs in to {servers}.',
            confirm: 'Remove and save'
        },
        willAdd: {
            one: '1 will start using it',
            other: '{count} will start using it'
        },
        willRemove: {
            one: '1 will stop using it',
            other: '{count} will stop using it'
        },
        save: 'Save',
        saved: 'Servers of "{name}" updated'
    },
    import: {
        identities: 'Identities',
        reviewTitle: 'These connections would sign in with credentials saved on this computer',
        reviewHint: 'The file names identities saved here, or asks to forward your SSH agent, for hosts it chooses. Their password or keys would be offered to those hosts.',
        toHost: 'connects to',
        savedIdentity: 'Saved identity "{identity}"',
        newIdentity: 'New identity "{identity}"',
        forwardsAgent: 'Forwards your SSH agent',
        consent: 'I trust these hosts: let them use these credentials',
        consentHint: 'Otherwise they are imported without the identity and without agent forwarding. You can give them one later in Settings › Keychain.',
        linked: {
            one: '1 connection signs in with credentials saved here:',
            other: '{count} connections sign in with credentials saved here:'
        },
        withheld: {
            one: '1 connection was imported without the saved credentials it asked for (give it an identity in Settings › Keychain if you trust it):',
            other: '{count} connections were imported without the saved credentials they asked for (give them an identity in Settings › Keychain if you trust them):'
        }
    },
    sshImport: {
        agent: 'SSH agent',
        hint: 'Hosts that share a key file (IdentityFile) or the SSH agent (IdentityAgent) get one identity in Settings › Keychain, so that key is changed in one place.'
    },
    agent: {
        checking: 'Looking for an SSH agent…',
        unknown: 'Could not check the SSH agent.',
        available: 'SSH agent connected',
        via: 'via {source}',
        keys: {
            one: '1 key available',
            other: '{count} keys available'
        },
        unreachable: 'SSH agent not reachable ({source})',
        none: 'No SSH agent',
        sources: {
            env: 'SHELLMIND_SSH_AGENT',
            'ssh-auth-sock': 'SSH_AUTH_SOCK',
            'windows-openssh': 'Windows OpenSSH agent',
            pageant: 'Pageant'
        },
        fix: {
            env: 'Check the path in SHELLMIND_SSH_AGENT.',
            'ssh-auth-sock': 'Is the agent still running?',
            'windows-openssh': 'Start the "OpenSSH Authentication Agent" service.',
            pageant: 'Start the "OpenSSH Authentication Agent" service or Pageant.'
        },
        reasons: {
            disabled: 'SHELLMIND_SSH_AGENT is set to off.',
            'remote-backend': 'ShellMind runs on another machine: its agent would not be yours. Set SHELLMIND_SSH_AGENT on that machine to use its agent.',
            'not-found': 'SSH_AUTH_SOCK is not set for ShellMind. Start ssh-agent (or your password manager\'s agent) before ShellMind.'
        },
        errors: {
            'not-running': 'Pageant is not running.',
            timeout: 'The agent did not answer in time.',
            unreachable: 'Nothing answers on its socket or pipe.'
        },
        showKeys: 'Keys',
        refresh: 'Check the SSH agent again'
    },
    editor: {
        newTitle: 'New identity',
        editTitle: 'Edit identity',
        description: 'Servers that use it take from it whatever they do not set themselves.',
        name: 'Name',
        namePlaceholder: 'e.g. deploy',
        username: 'Username',
        usernameHint: 'Optional. A server\'s own username wins.',
        password: 'Password',
        passwordHint: 'Optional. Also the Remote Desktop password of Windows servers without their own.',
        passwordPlaceholder: 'Password for this user',
        keepPlaceholder: 'Leave blank to keep the saved one',
        saved: 'Saved',
        willRemove: 'Removed on save',
        remove: 'Remove',
        removeLabel: 'Remove the saved {secret}',
        keepLabel: 'Keep the saved {secret}',
        key: 'Private key',
        keyModes: {
            keep: 'Current',
            none: 'None',
            generate: 'Generate',
            paste: 'Paste',
            file: 'File'
        },
        keyModeHints: {
            keep: 'Keep the stored key',
            none: 'No private key',
            generate: 'Generate a new ed25519 key pair, stored encrypted',
            paste: 'Paste a private key (OpenSSH, PEM or PuTTY)',
            file: 'Read the key from a file on the computer running ShellMind'
        },
        generateNote: 'A new ed25519 key pair is generated and stored encrypted. Only its public key is ever shown, to install it on servers.',
        comment: 'Key comment',
        commentHint: 'Shown next to the key in authorized_keys.',
        privateKey: 'Private key (PEM / OpenSSH)',
        replaceKeyHint: 'Replaces the stored key at once: servers that only accept the current key will reject it. Rotate the key to install the new one first.',
        keyPath: 'Private key file',
        keyPathHint: 'Read on the machine running ShellMind each time it connects. ~ is your home directory.',
        passphrase: 'Key passphrase',
        passphraseHint: 'Only if the key is encrypted.',
        passphraseGenerateHint: 'Optional. Encrypts the new key.',
        passphrasePlaceholder: 'No passphrase',
        keptPassphrase: 'Passphrase saved',
        keptPassphraseHint: 'The stored key keeps its passphrase. To use another one, rotate the key or paste it again with the new passphrase.',
        useAgent: 'Sign in with the SSH agent',
        useAgentHint: 'Uses the keys of ssh-agent, Pageant or the Windows OpenSSH agent on the computer running ShellMind (tried after the password and key).',
        usedBy: {
            one: 'Saving changes how 1 server signs in. Open sessions keep running; new connections use the new values.',
            other: 'Saving changes how {count} servers sign in. Open sessions keep running; new connections use the new values.'
        },
        create: 'Create identity',
        createAndGenerate: 'Create and generate key',
        save: 'Save changes',
        discard: {
            title: 'Discard changes?',
            message: 'The changes to this identity have not been saved.',
            confirm: 'Discard',
            cancel: 'Keep editing'
        },
        errors: {
            nameRequired: 'Enter a name.',
            nameTaken: 'Another identity already has this name.',
            keyRequired: 'Paste the private key.',
            keyInvalid: 'This private key cannot be read: check the key and its passphrase.',
            keyPathRequired: 'Enter the path of the key file.',
            keyOrFile: 'Use either a stored key or a key file, not both.'
        }
    }
};
