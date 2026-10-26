// W8-T2 Kubernetes workspace (src/features/k8s, the pod parts of the chat and
// the terminal tabs).
const en = {
    tab: 'Kubernetes',
    lookForKubectl: 'Kubernetes: look for kubectl on this server',
    detecting: 'Looking for kubectl on this server…',
    detectingLocal: 'Looking for kubectl on this computer…',
    redetectFailed: 'kubectl could not be checked again; the tab keeps what it found before.',
    checkAgain: 'Check again',
    install: 'How to install kubectl',
    retry: 'Retry',
    refresh: 'Refresh',
    refreshFailed: 'Refreshing failed; the list shows what was read before.',
    autoRefresh: 'Auto-refresh (10 s)',
    back: 'Back to the list',
    loading: 'Loading…',
    more: 'More',
    sortBy: 'Sort by {column}',
    context: 'Kubeconfig context',
    currentContext: "kubectl's current context",
    namespace: 'Namespace',
    allNamespaces: 'All namespaces',
    namespacesUnavailable: 'Namespaces cannot be listed',
    otherNamespace: {
        option: 'Other namespace…',
        title: 'Open another namespace',
        description: 'For a namespace you may work in that the list does not offer (when you may not list the cluster’s namespaces).',
        invalid: 'Lowercase letters, digits and “-”, up to 63 characters.',
        cancel: 'Cancel',
        confirm: 'Open'
    },
    unsupportedContexts: 'Left out (names with blanks, quotes or shell characters): {names}.',
    unsupportedContext: 'Cannot be used: its name has blanks, quotes or shell characters',
    viewsLabel: 'Kubernetes views',
    views: {
        workloads: 'Workloads',
        pods: 'Pods',
        events: 'Events',
        nodes: 'Nodes'
    },
    failingCount: '{count} pods failing',
    failingCountOne: '1 pod failing',
    runner: {
        ssh: 'kubectl {version} on the server',
        sshSudo: 'kubectl {version} on the server (sudo)',
        local: 'kubectl {version} on this computer'
    },
    unavailable: {
        KUBECTL_MISSING: {
            ssh: 'kubectl is not installed on this server',
            local: 'kubectl is not installed on this computer',
            hint: 'Install kubectl and set up a kubeconfig, then check again. On a server, ShellMind looks for it on the PATH of a non-interactive SSH session, in /usr/local/bin and in /snap/bin.'
        },
        NO_CONTEXTS: {
            ssh: 'kubectl has no clusters to work with on this server',
            local: 'kubectl has no clusters to work with on this computer',
            hint: 'Its kubeconfig (~/.kube/config or $KUBECONFIG) has no contexts. Add one, for example with the cloud CLI of your cluster, then check again.'
        },
        KUBECONFIG_ERROR: {
            ssh: "kubectl cannot read its kubeconfig on this server",
            local: "kubectl cannot read its kubeconfig on this computer",
            hint: 'kubectl said:'
        },
        UNSUPPORTED: {
            ssh: 'Kubernetes is not available for this connection',
            local: 'Kubernetes is not available for this connection',
            hint: 'It needs an SSH connection to a Linux server, or a local connection with the kubectl preset.'
        }
    },
    useContext: {
        action: "Make it kubectl's current context",
        already: "Already kubectl's current context",
        title: 'Make {context} the current context?',
        message: 'kubectl on {server} will use {context} from now on whenever no context is named, also outside ShellMind. This tab always names its context and is not affected.',
        messageLocal: 'kubectl on this computer will use {context} from now on whenever no context is named, also outside ShellMind. This tab always names its context and is not affected.',
        confirm: 'Make current',
        done: '{context} is now kubectl’s current context.',
        failed: 'Could not change the current context.'
    },
    kinds: {
        deployment: 'Deployment',
        statefulset: 'StatefulSet',
        daemonset: 'DaemonSet',
        job: 'Job',
        cronjob: 'CronJob'
    },
    kindsPlural: {
        deployment: 'Deployments',
        statefulset: 'StatefulSets',
        daemonset: 'DaemonSets',
        job: 'Jobs',
        cronjob: 'CronJobs'
    },
    owners: {
        Deployment: 'Deployment {name}',
        StatefulSet: 'StatefulSet {name}',
        DaemonSet: 'DaemonSet {name}',
        Job: 'Job {name}',
        CronJob: 'CronJob {name}',
        ReplicaSet: 'ReplicaSet {name}',
        ReplicationController: 'ReplicationController {name}',
        Node: 'static pod of node {name}'
    },
    health: {
        ok: 'Healthy',
        progressing: 'Rolling out',
        degraded: 'Degraded',
        failed: 'Failed',
        idle: 'Idle',
        suspended: 'Suspended',
        complete: 'Complete',
        running: 'Running'
    },
    workloads: {
        search: 'Search workloads',
        caption: '{count} workloads',
        captionOne: '1 workload',
        empty: 'No workloads in this namespace',
        noMatch: 'No workload matches the search',
        partial: 'Some kinds could not be listed (not allowed)',
        columns: {
            name: 'Name',
            ready: 'Ready',
            upToDate: 'Up to date',
            status: 'Status',
            age: 'Age',
            actions: 'Actions'
        },
        available: '{count} available',
        activeJobs: '{count} active jobs',
        activeJobsOne: '1 active job',
        succeeded: '{done}/{total} succeeded',
        actionsFor: 'Actions for {name}',
        showPods: 'Show its {count} pods',
        showPodsOne: 'Show its pod',
        restart: {
            action: 'Restart (rollout)',
            title: 'Restart {kind} {name}?',
            message: 'kubectl rollout restart replaces the pods of {name} with new ones, following its update strategy (one by one for most deployments). Requests to pods that are being replaced may fail.',
            confirm: 'Restart',
            done: 'Restart of {name} started.',
            failed: 'Could not restart {name}.'
        }
    },
    scale: {
        action: 'Scale…',
        title: 'Scale {kind} {name}',
        description: 'It runs {current} replicas now ({ready} ready).',
        replicas: 'Replicas',
        hint: 'From 0 to {max}.',
        invalid: 'Enter a whole number from 0 to {max}.',
        zero: 'With 0 replicas every pod of it stops until it is scaled up again.',
        cancel: 'Cancel',
        confirm: 'Scale',
        done: '{name} scaled to {count} replicas.',
        doneOne: '{name} scaled to 1 replica.',
        failed: 'Could not scale {name}.'
    },
    pods: {
        search: 'Search pods, nodes, containers',
        filterLabel: 'Show pods',
        filter: {
            all: 'All',
            problems: 'Needs attention',
            running: 'Running',
            completed: 'Finished'
        },
        ofWorkload: 'Pods of {kind} {name}',
        clearWorkload: 'Show every pod',
        truncated: 'Only the first {count} pods are shown: choose a namespace to see the rest.',
        caption: '{count} pods',
        captionOne: '1 pod',
        empty: 'No pods here',
        emptyHint: 'The namespace {namespace} has no pods. Pick another one above.',
        emptyAll: 'The cluster has no pods you may list.',
        noMatch: 'No pod matches the filter',
        columns: {
            name: 'Name',
            status: 'Status',
            ready: 'Ready',
            restarts: 'Restarts',
            node: 'Node',
            age: 'Age',
            shell: 'Shell'
        },
        ago: '{age} ago'
    },
    pod: {
        detailLabel: 'Pod {name}',
        gone: 'This pod is no longer listed (it may have been deleted or replaced).',
        askAiHint: 'Its state, events and recent logs are collected and shown to you before anything is sent.',
        close: 'Close the pod',
        actionsLabel: 'Pod actions',
        tabsLabel: 'Pod details',
        tabs: {
            overview: 'Overview',
            logs: 'Logs',
            events: 'Events'
        },
        namespace: 'Namespace',
        owner: 'Controlled by',
        noOwner: 'Nothing (a bare pod)',
        node: 'Node',
        unscheduled: 'Not scheduled yet',
        ip: 'Pod IP',
        hostIp: 'node {ip}',
        qos: 'QoS class',
        serviceAccount: 'Service account',
        created: 'Created',
        started: 'Started',
        conditions: 'Conditions',
        initContainers: 'Init containers',
        volumes: 'Volumes',
        delete: {
            action: 'Delete pod',
            title: 'Delete the pod {name}?',
            replaced: 'Its {owner} creates a new pod to replace it: useful to restart a single stuck pod.',
            cleanup: 'The pod has stopped and its {owner} already runs others in its place: deleting it only clears it away, with its logs.',
            jobRunning: 'Its {owner} may start a new pod to finish the work, if its retry limit allows. The logs of this pod are lost.',
            jobFinished: 'The pod has finished and its {owner} will not run it again: the pod and its logs are gone for good.',
            otherOwner: 'It belongs to {owner}, whose controller decides whether a new pod replaces it. The logs of this pod are lost.',
            mirror: 'The kubelet of node {node} runs this static pod from a file and puts it back at once: deleting it here does not stop it.',
            unowned: 'No controller recreates it: the pod and what it runs are gone for good.',
            confirm: 'Delete pod',
            done: 'Pod {name} is being deleted.',
            failed: 'Could not delete the pod {name}.'
        }
    },
    container: {
        label: 'Container {name}',
        init: 'init',
        sidecar: 'sidecar',
        ready: 'Ready',
        notReady: 'Not ready',
        restarts: '{count} restarts',
        restartsOne: '1 restart',
        state: 'State',
        lastState: 'Last state',
        exitCode: 'exit code {code}',
        signal: 'signal {signal}',
        ports: 'Ports',
        requests: 'Requests',
        limits: 'Limits',
        command: 'Command',
        states: {
            running: 'Running',
            waiting: 'Waiting',
            terminated: 'Terminated',
            unknown: 'Unknown'
        }
    },
    env: {
        title: 'Environment',
        empty: 'No environment variables are set in the pod spec.',
        hint: 'Values are hidden until you show them. Secret references are never read.',
        showAll: 'Show all',
        hideAll: 'Hide all',
        show: 'Show {name}',
        hide: 'Hide {name}',
        copy: 'Copy the value of {name}',
        copied: 'Value of {name} copied.',
        copyFailed: 'Could not copy the value.',
        masked: 'hidden value',
        from: 'from {source}',
        envFrom: 'Also every key of: {sources}'
    },
    shell: {
        open: 'Shell',
        openIn: 'Open a shell in {name}',
        choose: 'Choose the container',
        inContainer: 'Shell in {name}',
        inInitContainer: 'Shell in {name} (init container)',
        notRunning: 'The pod has no running container to open a shell in.',
        terminating: 'The pod is being deleted.',
        noRunningContainer: 'None of its containers is running.',
        containerNotRunning: '{name} is not running ({state}).'
    },
    logs: {
        container: 'Container',
        tail: 'Lines of backlog',
        previous: 'Previous instance',
        noPrevious: 'The container has not restarted: there is no previous instance.',
        follow: 'Follow',
        followPrevious: 'The previous instance has ended: there is nothing to follow.',
        timestamps: 'Timestamps',
        start: 'Show logs',
        stop: 'Stop',
        pause: 'Pause',
        resume: 'Resume',
        stick: 'Stay at the end',
        clear: 'Clear',
        download: 'Download',
        filter: 'Filter lines',
        askAi: 'Ask AI about {name} and its logs',
        outputLabel: 'Logs of {name}',
        count: '{count} lines',
        countOne: '1 line',
        countFiltered: '{shown} of {total} lines',
        pausedCount: 'Paused: {count} new lines waiting',
        discarded: '{count} older lines dropped to stay within the limit',
        dropped: '{size} skipped because the view could not keep up',
        waiting: 'Waiting for log lines…',
        idle: 'Pick the options above, then show the logs.',
        noLines: 'No log lines.',
        backendLost: 'The connection to ShellMind was lost.',
        status: {
            idle: 'Not started',
            connecting: 'Connecting',
            streaming: 'Live',
            ended: 'Ended',
            error: 'Failed',
            endedCode: 'Ended (exit {code})'
        }
    },
    events: {
        label: 'Events',
        search: 'Search events',
        filterLabel: 'Show events',
        filter: {
            all: 'All',
            warnings: 'Warnings'
        },
        warning: 'Warning:',
        normal: 'Event:',
        countAgo: '×{count} · {age} ago',
        openPod: 'Open the pod {name}',
        empty: 'No events',
        emptyHint: 'Kubernetes keeps events for about an hour.'
    },
    nodes: {
        caption: '{count} nodes',
        captionOne: '1 node',
        empty: 'No nodes (or you may not list them)',
        columns: {
            name: 'Name',
            status: 'Status',
            version: 'Version',
            capacity: 'Capacity',
            age: 'Age',
            actions: 'Actions'
        },
        ready: 'Ready',
        notReady: 'Not ready',
        unknown: 'Unknown',
        cordoned: 'scheduling disabled',
        worker: 'worker',
        pods: '{count} listed pods',
        podsOne: '1 listed pod',
        capacity: '{cpu} CPU · {memory}',
        cordon: {
            action: 'Cordon',
            title: 'Cordon the node {name}?',
            message: 'No new pods are scheduled on {name} until it is uncordoned. The pods running there keep running (cordoning does not drain the node).',
            confirm: 'Cordon',
            done: '{name} is cordoned.',
            failed: 'Could not cordon {name}.'
        },
        uncordon: {
            action: 'Uncordon',
            title: 'Uncordon the node {name}?',
            message: 'New pods may be scheduled on {name} again.',
            confirm: 'Uncordon',
            done: '{name} accepts new pods again.',
            failed: 'Could not uncordon {name}.'
        }
    },
    errors: {
        K8S_AUTH_REQUIRED: 'The cluster wants you to sign in again.',
        K8S_FORBIDDEN: 'You are not allowed to do this in the cluster.',
        K8S_CONTEXT_NOT_FOUND: 'The kubeconfig no longer has this context. Check again.',
        K8S_NOT_FOUND: 'It no longer exists in the cluster.',
        K8S_UNREACHABLE: 'The cluster cannot be reached.',
        K8S_TIMEOUT: 'kubectl did not answer in time.',
        K8S_COMMAND_FAILED: 'kubectl reported an error.',
        K8S_INVALID_INPUT: 'That name is not valid.',
        K8S_UNSUPPORTED: 'Kubernetes is not available for this connection.',
        K8S_UNAVAILABLE: 'kubectl has no usable kubeconfig here.',
        K8S_CONTAINER_NOT_RUNNING: 'The container is not running.',
        KUBECTL_MISSING: 'kubectl is not installed here.'
    },
    terminal: {
        tabName: 'pod: {pod}/{container}',
        connecting: 'Opening a shell in {container} of the pod {pod} ({namespace}, context {context})…'
    },
    ai: {
        attachment: 'Pod {namespace}/{name}',
        prompt: 'What is wrong with the pod {name} in {namespace}, and how do I fix it?',
        sections: {
            pod: 'Pod state',
            'pod-events': 'Pod events',
            'pod-logs': 'Container logs (last 200 lines)',
            'pod-previous-logs': 'Logs of the previous instance'
        }
    }
};

export default en;
