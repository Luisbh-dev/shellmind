export default {
    title: 'Multi-exec',
    jobsAction: 'Multi-exec jobs',
    subtitle: 'Run one command on many SSH servers as a background job: all at once or in batches, with a canary first.',
    loading: 'Loading…',
    loadFailed: 'The servers could not be loaded: {error}',
    tabs: {
        label: 'Multi-exec',
        new: 'New job',
        jobs: 'Jobs',
        running: '{count} running'
    },
    targets: {
        title: 'Servers',
        selected: 'Selected: {count}',
        search: 'Search servers',
        group: 'Group',
        allGroups: 'All groups',
        noGroup: 'No group',
        tag: 'Tag',
        allTags: 'All tags',
        selectVisible: 'Select shown ({count})',
        clear: 'Clear',
        noMatch: 'No server matches these filters.',
        none: 'No SSH servers saved (multi-exec runs on Linux and Windows servers).',
        hiddenSelected: 'Also selected, hidden by the filters: {count}'
    },
    compose: {
        source: 'Command source',
        command: 'Command',
        snippet: 'Snippet',
        commandLabel: 'Command',
        commandHint: 'Runs non-interactively (no terminal): commands that ask for input, such as sudo with a password, fail. {{name}} placeholders are asked for before it runs.',
        fromSnippet: 'From the snippet "{name}".',
        snippetLabel: 'Snippet',
        chooseSnippet: 'Choose a snippet…',
        noSnippets: 'No snippets saved yet',
        timeout: 'Timeout per server (seconds)',
        timeoutHint: 'Connecting included. The command is stopped when it takes longer.',
        concurrency: 'Parallel servers',
        concurrencyHint: 'How many servers run it at the same time.',
        secretsHidden: 'Secret values are hidden here. They are sent to the servers only: the audit log and the job history keep their {{placeholder}}.',
        rerunNote: 'Running the job again on the servers where it did not succeed.',
        maskedHistory: 'Parts of this command were masked in the history because they looked like secrets. Type them again before running it.',
        showRunning: 'Show the running job',
        needTargets: 'Select at least one server.',
        tooManyTargets: 'Select at most {max} servers.',
        needSnippet: 'Choose a snippet.',
        snippetScoped: '"{name}" is only available on {server}: select only that server, or choose another snippet.',
        needCommand: 'Enter a command.',
        commandTooLong: 'The command can have at most {max} characters once filled in.',
        badTimeout: 'The timeout must be a whole number of seconds from 1 to {max}.',
        badConcurrency: 'Parallel servers must be a whole number from 1 to {max}.',
        review: 'Review'
    },
    strategy: {
        title: 'Rollout',
        mode: 'Rollout',
        parallel: 'All at once',
        parallelHint: 'Every server runs it, a few at a time.',
        rolling: 'Rolling batches',
        rollingHint: 'A batch at a time: the next batch starts when the previous one has finished.',
        batchSize: 'Batch size',
        batchUnit: 'Batch size unit',
        unitPercent: '%',
        unitServers: 'servers',
        pause: 'Pause between batches (s)',
        canary: 'Start with a canary',
        canaryHint: 'A few servers run it first; the others wait until they finish.',
        canaryCount: 'Canary servers',
        canaryThen: 'Then',
        thenPause: 'Wait for my approval',
        thenPauseHint: 'The job pauses after the canary until you continue it.',
        thenContinue: 'Continue if they all succeed',
        thenContinueHint: 'A failed canary still waits for your decision.',
        failureLimit: 'Stop after failures',
        failureLimitHint: 'No more servers start once this many have failed or timed out; those running finish.',
        failureCount: 'Failed servers',
        failurePercent: 'or % of servers',
        badBatchSize: 'The batch size must be a whole number of servers from 1 to {max}.',
        badBatchPercent: 'The batch size must be a percentage from 1 to {max}.',
        badPause: 'The pause between batches must be a whole number of seconds from 0 to {max}.',
        canaryNeedsTwo: 'A canary needs at least two servers selected.',
        badCanary: 'The canary must be a whole number of servers from 1 to {max} (fewer than those selected).',
        needFailureLimit: 'Enter how many failures (or what percentage) stop the job.',
        badFailureCount: 'The number of failures must be a whole number from 1 to {max}.',
        badFailurePercent: 'The failure percentage must be a whole number from 1 to 100.'
    },
    plan: {
        title: 'Plan',
        batchesLabel: 'Batches',
        canaryName: 'Canary',
        canaryShort: 'C · {count}',
        batchName: 'Batch {number}',
        servers: {
            one: '1 server',
            other: '{count} servers'
        },
        state: {
            pending: 'waiting',
            current: 'running',
            done: 'done',
            failed: 'with failures',
            skipped: 'not run'
        },
        canary: {
            one: 'Canary: 1 server first, then {then}.',
            other: 'Canary: {count} servers first, then {then}.'
        },
        thenApprove: 'wait for your approval',
        thenContinue: 'continue if they all succeed',
        thenWaitContinue: 'wait {seconds} s and continue if they all succeed',
        allAtOnce: {
            one: 'Runs on 1 server.',
            other: 'All {count} servers, up to {concurrency} at a time.'
        },
        restAtOnce: {
            one: 'Then the remaining server.',
            other: 'Then the remaining {count} servers, up to {concurrency} at a time.'
        },
        batches: {
            one: '{batches} batches of 1 server each.',
            other: '{batches} batches of up to {size} servers, up to {concurrency} at a time.'
        },
        pause: '{seconds} s between batches.',
        stopAfter: {
            one: 'Stops at the first failure.',
            other: 'Stops after {count} failures.'
        },
        stopAfterPercent: 'Stops once {percent} % of the servers have failed.',
        stopAfterBoth: {
            one: 'Stops at the first failure or once {percent} % of the servers have failed, whichever comes first.',
            other: 'Stops after {count} failures or {percent} % of the servers, whichever comes first.'
        }
    },
    confirm: {
        title: {
            one: 'Run this command on 1 server?',
            other: 'Run this command on {count} servers?'
        },
        details: 'Each server is stopped after {timeout} s, up to {concurrency} at a time. Every command is recorded in the audit log, and so is the hostname that ShellMind runs once per connection to group identical outputs. The job keeps running if you close this window.',
        command: 'Command',
        servers: 'Servers',
        back: 'Back',
        run: {
            one: 'Run on 1 server',
            other: 'Run on {count} servers'
        }
    },
    danger: {
        title: 'Destructive command',
        message: {
            one: 'This command {reason}, and it will run on 1 server. Check it carefully.',
            other: 'This command {reason}, and it will run on {count} servers. Check it carefully.'
        },
        typeToConfirm: 'Type {count} (the number of servers) to confirm:',
        reasons: {
            recursiveDelete: 'deletes files recursively',
            disk: 'writes to or formats a disk',
            power: 'shuts down or restarts the machine',
            forkBomb: 'can exhaust the machine (fork bomb)',
            permissions: 'changes ownership or permissions of the whole system',
            database: 'deletes database data',
            firewall: 'resets the firewall rules',
            cloudDelete: 'deletes cloud resources',
            containerData: 'deletes container data',
            processes: 'kills every process',
            scheduler: 'deletes scheduled jobs',
            remoteCode: 'downloads a script from the internet and runs it',
            backdoor: 'opens remote access or sends data off the machine',
            overwrite: 'overwrites a critical system file'
        }
    },
    status: {
        queued: 'Queued',
        running: 'Running',
        ok: 'OK',
        failed: 'Failed',
        timeout: 'Timed out',
        cancelled: 'Cancelled',
        skipped: 'Not run'
    },
    jobStatus: {
        running: 'Running',
        paused: 'Paused',
        done: 'Done',
        doneWithFailures: 'Done with failures',
        stopped: 'Stopped',
        cancelled: 'Cancelled',
        interrupted: 'Interrupted'
    },
    job: {
        title: 'Job',
        pause: 'Pause',
        resume: 'Resume',
        cancel: 'Cancel job',
        batchOf: 'Batch {number} of {total}',
        canaryRunning: 'Canary',
        pausedProgress: 'Paused · {done} of {total} finished',
        stopping: 'Stopping: the failure limit was reached; the servers still running finish.',
        doneWithFailures: 'Finished: {ok} OK, {failed} failed',
        stopped: {
            'failure-limit': {
                one: 'Stopped by the failure limit ({failed} failed); 1 server was not run.',
                other: 'Stopped by the failure limit ({failed} failed); {count} servers were not run.'
            },
            'pause-timeout': {
                one: 'Stopped: nobody resumed it in time; 1 server was not run.',
                other: 'Stopped: nobody resumed it in time; {count} servers were not run.'
            },
            lifetime: 'Stopped: the job ran for too long.'
        },
        interrupted: 'Interrupted: ShellMind closed while the job was running.',
        reconnecting: 'Lost the connection to the job: reconnecting…',
        rerunOf: 'Re-run of an earlier job'
    },
    gate: {
        canaryOk: {
            one: 'Canary finished: {ok} of {total} OK. Continue with the remaining server?',
            other: 'Canary finished: {ok} of {total} OK. Continue with the remaining {count} servers?'
        },
        canaryFailed: {
            one: 'The canary server failed. Check its result, then continue anyway or cancel the job.',
            other: 'The canary failed on {failed} of {count} servers. Check the results, then continue anyway or cancel the job.'
        },
        paused: 'Paused: no new servers start; those running finish.',
        expires: 'The job stops if it is not continued within {time}.',
        continue: 'Continue',
        continueAnyway: 'Continue anyway',
        limitReached: 'Failure limit reached: no more servers start.',
        nextBatch: 'Next batch in {time}'
    },
    filter: {
        label: 'Filter by status',
        all: 'All',
        problems: 'Not OK'
    },
    groups: {
        title: 'Results by output',
        normalize: 'Ignore host names, times and PIDs',
        summary: '{identical}, {different}',
        identical: {
            one: '1 identical',
            other: '{count} identical'
        },
        different: {
            one: '1 different',
            other: '{count} different'
        },
        allSame: 'All {count} printed the same',
        oneServer: '1 server finished',
        without: '{count} without output',
        pending: '{count} still running or queued',
        nothingYet: 'No server has finished yet.',
        majority: 'Group A · most common output',
        variant: 'Group {letter} · different output',
        label: 'Group {letter}',
        servers: {
            one: '1 server',
            other: '{count} servers'
        },
        members: 'Servers in this group',
        more: 'and {count} more',
        fewer: 'show fewer',
        compare: 'Compare with {letter}',
        none: {
            queued: 'Queued',
            running: 'Running',
            ok: 'No output',
            failed: 'Failed without output',
            timeout: 'Timed out',
            cancelled: 'Cancelled before it ran',
            skipped: 'Not run (the job stopped first)'
        }
    },
    diff: {
        label: 'Differences between {base} and {other}',
        summary: '{added}, {removed}',
        linesAdded: {
            one: '1 line added',
            other: '{count} lines added'
        },
        linesRemoved: {
            one: '1 removed',
            other: '{count} removed'
        },
        add: 'added',
        remove: 'removed',
        equal: 'unchanged',
        sameText: 'The output is the same; the exit code or status differs.',
        sameKept: 'The parts kept in the history are identical: the difference is further on.',
        trimmed: 'Only the start of each output is kept in the history.',
        coarse: 'The outputs differ too much for a line-by-line comparison: the differing part is shown whole.',
        moreHunks: {
            one: '1 more changed part not shown.',
            other: '{count} more changed parts not shown.'
        }
    },
    results: {
        show: 'Show results',
        grouped: 'By output',
        byServer: 'By server',
        progress: 'Running… {done} of {total} finished',
        finished: {
            one: 'Finished on 1 server',
            other: 'Finished on {count} servers'
        },
        cancelledRun: 'Job cancelled',
        servers: 'Results by server',
        noneMatch: 'No server matches this filter.',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        exitCode: 'Exit code',
        exit: 'exit {code}',
        duration: 'Duration',
        copyOutput: 'Copy the output of {server}',
        outputCopied: 'Output copied',
        copyFailed: 'The clipboard is not available',
        truncated: 'Output truncated: only the first 256 KB were kept.',
        trimmed: 'Only the first 64 KB of the output are kept in the history.',
        noOutput: 'No output.',
        skipped: 'Not run: the job stopped before it reached this server.',
        waiting: 'Waiting for output…',
        exportJson: 'JSON',
        exportCsv: 'CSV',
        exportText: 'Text',
        auditLog: 'Audit log',
        rerunFailed: 'Run again where it failed ({count})',
        rerunUnfinished: 'Run again where it did not succeed ({count})',
        mayHaveRun: {
            one: 'Not part of "Run again": 1 server where the job was cut off while the command ran. It may have run there already; start a new job to include it.',
            other: 'Not part of "Run again": {count} servers where the job was cut off while the command ran. It may have run there already; start a new job to include them.'
        },
        newRun: 'New job from this one'
    },
    jobs: {
        running: 'Running',
        finished: 'History',
        all: 'All jobs',
        new: 'New job',
        empty: 'No jobs yet',
        emptyHint: 'Jobs you run appear here with their results, and stay after the window is closed.',
        loadFailed: 'The job history could not be loaded: {error}',
        servers: {
            one: '1 server',
            other: '{count} servers'
        },
        outcome: '{ok} OK · {failed} failed',
        progress: '{done} of {total} finished',
        delete: 'Delete from the history',
        deleteRunning: 'Cancel the job before deleting it',
        deleteTitle: 'Delete this job?',
        deleteMessage: 'Its results and outputs are removed from the history. The audit log keeps its entries.',
        clear: 'Clear history',
        clearTitle: 'Clear the job history?',
        clearMessage: 'Every finished job and its outputs are removed. Running jobs and the audit log are kept.',
        cleared: 'Jobs removed from the history: {count}',
        loadMore: 'Show older jobs',
        loadMoreFailed: 'The older jobs could not be loaded: {error}'
    },
    notify: {
        done: {
            one: 'Multi-exec job finished: 1 OK',
            other: 'Multi-exec job finished: {count} OK'
        },
        doneWithFailures: 'Multi-exec job finished: {ok} OK, {failed} failed',
        stopped: {
            'failure-limit': 'Multi-exec job stopped by its failure limit ({failed} failed)',
            'pause-timeout': 'Multi-exec job stopped: it was not continued in time',
            lifetime: 'Multi-exec job stopped: it ran for too long'
        },
        cancelled: 'Multi-exec job cancelled',
        interrupted: 'Multi-exec job interrupted',
        canaryOk: 'Canary OK: the multi-exec job waits for your approval',
        canaryFailed: 'The canary failed: the multi-exec job waits for your decision'
    },
    errors: {
        noStream: 'The backend did not return an event stream.',
        busy: 'Too many multi-exec jobs are running right now. Wait for one to finish and try again.',
        closing: 'ShellMind is shutting down: the job was not started.',
        dangerous: 'The backend refused the destructive command because it was not confirmed. Review it again.',
        missing: 'These servers no longer exist: {list}. Reopen multi-exec to reload the list.',
        unsupported: 'Multi-exec only runs on SSH servers (Linux and Windows): {list}.',
        rejected: 'The backend did not accept the job: {error}',
        finished: 'The job has already finished.',
        notFound: 'This job no longer exists (it was deleted from the history).',
        active: 'Cancel the job before deleting it.',
        pauseFailed: 'The job could not be paused',
        resumeFailed: 'The job could not be resumed',
        cancelFailed: 'The job could not be cancelled',
        deleteFailed: 'The job could not be deleted'
    },
    // Why a server did not succeed (by MultiExecErrorCode).
    serverErrors: {
        TIMEOUT: 'The command did not finish within {seconds} s and was stopped.',
        CONNECT_TIMEOUT: 'Could not connect within {seconds} s; the command did not run.',
        HANDSHAKE_TIMEOUT: 'The server did not complete the SSH handshake in time.',
        SIGNAL: 'The command was ended by the signal {signal}.',
        NO_EXIT_STATUS: 'The server did not report an exit code.',
        AUTH_FAILED: 'Authentication failed: the server rejected the saved credentials.',
        HOST_KEY_MISMATCH: 'The host key of the server has changed since it was trusted. Check it in Known hosts before connecting again.',
        CONNECTION_REFUSED: 'The server refused the connection. Is SSH running on that port?',
        HOST_NOT_FOUND: 'The host name could not be resolved.',
        HOST_UNREACHABLE: 'The host could not be reached.',
        INTERRUPTED: 'ShellMind closed (or its backend stopped) while the command was running: it may have run in full or in part.'
    },
    export: {
        title: 'ShellMind multi-exec results',
        command: 'Command',
        started: 'Started',
        status: 'Status',
        servers: 'Servers',
        exit: 'exit {code}',
        error: 'Error'
    }
};
