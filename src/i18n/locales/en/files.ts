export default {
    connecting: 'Opening the file session…',
    loading: 'Loading…',
    toolbar: {
        up: 'Go to the parent folder (Backspace)',
        home: 'Go to the home folder',
        root: 'Go to the root folder',
        refresh: 'Refresh',
        newFolder: 'New folder',
        upload: 'Upload files',
        editPath: 'Edit path (Ctrl+L)',
        pathLabel: 'Folder path',
        breadcrumb: 'Current folder',
        filter: 'Filter by name',
        clearFilter: 'Clear filter',
        showHidden: 'Show hidden files',
        hideHidden: 'Hide hidden files'
    },
    columns: {
        selectAll: 'Select all',
        name: 'Name',
        size: 'Size',
        modified: 'Modified',
        permissions: 'Permissions',
        actions: 'Actions'
    },
    sortBy: 'Sort by {column}',
    list: {
        label: 'Files in {path}',
        empty: 'This folder is empty',
        emptyHint: 'Drag files here or use Upload.',
        noMatches: 'No items match “{filter}”',
        hiddenOnly: 'Only hidden items here',
        showHiddenAction: 'Show hidden files',
        truncated: 'Showing the first {count} entries of this folder.',
        selectRow: 'Select {name}',
        link: 'symbolic link',
        summary: '{count} items',
        summaryOne: '1 item',
        selection: '{count} selected ({size})',
        selectionOne: '1 selected ({size})',
        keyboardHelp: 'Arrows move, Shift+arrows select, Enter opens, Backspace goes up, Delete deletes, F2 renames, Ctrl+A selects all.'
    },
    actions: {
        edit: 'Edit',
        download: 'Download',
        rename: 'Rename',
        delete: 'Delete',
        clearSelection: 'Clear selection',
        downloadSelected: 'Download ({count})',
        deleteSelected: 'Delete ({count})'
    },
    drop: {
        title: 'Drop to upload',
        target: 'to {path}'
    },
    connection: {
        failedTitle: 'Could not open the file session',
        closedTitle: 'The file session was closed',
        listFailedTitle: 'Could not list this folder',
        timeout: 'The server did not answer in time.',
        lost: 'The connection to the ShellMind backend was lost. Reconnecting…',
        unauthorized: 'The ShellMind backend refused the access token. Reload the app to sign in again.',
        retry: 'Reconnect',
        retryList: 'Try again',
        goRoot: 'Open the root folder'
    },
    hostKey: {
        title: 'The host key of {host} has changed',
        explanation: 'The server presented a different key than the one pinned the first time you connected. This happens after a reinstall or a key rotation, but it can also mean someone is intercepting the connection. Nothing was sent to the server.',
        keyType: 'Key type',
        expected: 'Pinned fingerprint',
        actual: 'Presented fingerprint',
        trust: 'Trust the new key and reconnect',
        confirmTitle: 'Trust the new host key?',
        confirmMessage: 'Only do this if you know why the key of {host} changed (for example, you reinstalled the server). From now on only the key {fingerprint} is trusted; any other key is refused again.',
        confirm: 'Trust and reconnect',
        failed: 'Could not trust the new key',
        changedAgain: 'The pinned key changed again in the meantime. Compare the keys shown now before trusting one.'
    },
    insecure: {
        ftp: 'Plain FTP: the password and the files travel unencrypted. Enable FTPS in the connection settings if the server supports it.',
        http: 'This S3 endpoint uses http://: the credentials and the data travel unencrypted.',
        dismiss: 'Hide this warning'
    },
    errors: {
        NOT_CONNECTED: 'Not connected',
        NOT_FOUND: 'Not found',
        PERMISSION_DENIED: 'Permission denied',
        EXISTS: 'Already exists',
        NOT_EMPTY: 'The folder is not empty',
        NOT_A_FILE: 'Not a file',
        NOT_A_DIRECTORY: 'Not a folder',
        TOO_LARGE: 'Too large',
        CONFLICT: 'Changed on the server',
        INVALID: 'Invalid request',
        CANCELLED: 'Cancelled',
        TIMEOUT: 'Timed out',
        PARTIAL: 'Partly done',
        UNSUPPORTED: 'Not supported by the server',
        BUSY: 'No free connection',
        NOT_ATOMIC: 'Can only be overwritten in place',
        FAILED: 'Failed'
    },
    // Where downloads are saved (see saveTarget.ts).
    download: {
        tooLargeForMemory: '{name} is {size}: too large to download here. This browser keeps a download in memory until it is complete, which allows at most {limit}. The desktop app and Chromium-based browsers (Chrome, Edge) save large files straight to disk.',
        // Same limit, but the page is served over plain HTTP: no browser can
        // write to disk there.
        tooLargeInsecure: '{name} is {size}: too large to download here. This page is not served over HTTPS, so the browser keeps a download in memory until it is complete, which allows at most {limit}. To save large files straight to disk, open ShellMind over HTTPS (or on localhost) in a Chromium-based browser (Chrome, Edge), or use the desktop app.',
        writeFailed: 'Could not write to the chosen file: {message}'
    },
    // Failures the app notices itself (no answer, lost connection).
    client: {
        noAnswer: 'The server did not answer in time.',
        connectionLost: 'The connection to the ShellMind backend was lost.',
        stalled: 'Nothing arrived for a minute, so the download was stopped.'
    },
    toast: {
        navigateFailed: 'Could not open {path}',
        folderCreated: 'Folder created',
        createFailed: 'Could not create the folder',
        renamed: 'Renamed to {name}',
        renameFailed: 'Could not rename',
        deleted: 'Deleted {count} items',
        deletedOne: 'Deleted 1 item',
        deletePartial: '{failed} items could not be deleted',
        deletePartialOne: '1 item could not be deleted',
        deleteFailed: 'Could not delete',
        foldersSkipped: 'Folders cannot be downloaded; {count} skipped',
        refreshFailed: 'Could not refresh the folder'
    },
    nameDialog: {
        newFolderTitle: 'New folder',
        newFolderDescription: 'Inside {path}',
        renameTitle: 'Rename',
        renameDescription: 'Current name: {name}',
        label: 'Name',
        create: 'Create',
        rename: 'Rename',
        problems: {
            empty: 'Enter a name.',
            slash: 'A name cannot contain “/”.',
            dots: '“.” and “..” are not valid names.',
            tooLong: 'The name is too long: at most 255 bytes, and accented letters and symbols take two to four each.',
            // S3: the folder path and the name together.
            keyTooLong: 'The name is too long for this folder: its full path in the bucket can be at most 1024 bytes, and accented letters and symbols take two to four each.',
            exists: 'Something with this name already exists here.'
        }
    },
    deleteDialog: {
        title: 'Delete {count} items?',
        titleOne: 'Delete “{name}”?',
        counting: 'Counting what will be deleted…',
        contents: 'This permanently deletes {files} and {dirs} ({size}).',
        contentsAtLeast: 'This permanently deletes at least {files} and {dirs} ({size}); counting stopped there.',
        fileCount: '{count} files',
        fileCountOne: '1 file',
        folderCount: '{count} folders',
        folderCountOne: '1 folder',
        countFailed: 'The contents could not be counted. Everything inside the selected folders will be deleted.',
        filesOnly: 'This permanently deletes {count} files ({size}).',
        fileOnly: 'This permanently deletes the file ({size}).',
        irreversible: 'This cannot be undone.',
        confirm: 'Delete',
        more: 'and {count} more'
    },
    overwriteDialog: {
        title: '{count} items already exist',
        titleOne: '“{name}” already exists',
        description: 'In {path}. What should happen to the existing files?',
        replace: 'Replace',
        skip: 'Skip',
        keepBoth: 'Keep both',
        folderClash: 'A folder has this name; it can only be kept or the upload renamed.',
        more: 'and {count} more'
    },
    transfers: {
        title: 'Transfers',
        active: '{count} active',
        upload: 'Upload',
        download: 'Download',
        queued: 'Waiting',
        waiting: 'Waiting for a free connection',
        done: 'Done',
        failed: 'Failed',
        cancelled: 'Cancelled',
        cancel: 'Cancel {name}',
        retry: 'Retry {name}',
        dismiss: 'Remove {name} from the list',
        clearFinished: 'Clear finished',
        collapse: 'Collapse transfers',
        expand: 'Expand transfers',
        progress: '{name}: {percent}%',
        inPlaceHint: 'The folder is not writable, so the file can only be overwritten directly. If that upload is interrupted, the file stays damaged.',
        inPlace: 'Overwrite {name} directly',
        needsTarget: 'Where to save?',
        chooseTarget: 'Choose where to save {name}'
    }
};
