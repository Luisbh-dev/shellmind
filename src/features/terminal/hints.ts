// Quick commands offered per kind of connection. Texts live in the
// "terminal.hints" i18n area; commands with a placeholder are `editable`:
// they are typed into the prompt for the user to complete, never run as-is.
import type { WorkspaceServer } from '@/workspace/types';

export type Hint = { id: string; cmd: string; editable?: boolean };
export type HintGroup = { id: string; items: Hint[] };

const LINUX: HintGroup[] = [
    {
        id: 'health',
        items: [
            { id: 'diskUsage', cmd: 'df -h' },
            { id: 'memoryUsage', cmd: 'free -m' },
            { id: 'uptime', cmd: 'uptime' },
            { id: 'topProcesses', cmd: 'ps aux --sort=-%cpu | head -n 10' }
        ]
    },
    {
        id: 'services',
        items: [
            { id: 'failedServices', cmd: 'systemctl --failed' },
            { id: 'recentLogs', cmd: 'journalctl -xe --no-pager | tail -n 50' },
            { id: 'listeningPorts', cmd: 'ss -tulpn' },
            { id: 'restartService', cmd: 'sudo systemctl restart ', editable: true }
        ]
    }
];

const WINDOWS: HintGroup[] = [
    {
        id: 'windowsHealth',
        items: [
            { id: 'systemInfo', cmd: 'systeminfo' },
            { id: 'processes', cmd: 'tasklist' },
            { id: 'memoryStatus', cmd: 'powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize"' },
            { id: 'networkStatus', cmd: 'netstat -an' }
        ]
    },
    {
        id: 'windowsTroubleshooting',
        items: [
            { id: 'ipConfig', cmd: 'ipconfig /all' },
            { id: 'windowsServices', cmd: 'powershell -Command "Get-Service | Sort-Object Status,Name"' },
            { id: 'recentEvents', cmd: 'powershell -Command "Get-WinEvent -LogName System -MaxEvents 20 | Format-Table -AutoSize"' },
            { id: 'topCpu', cmd: 'powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,CPU,Id"' }
        ]
    }
];

const FTP: HintGroup[] = [
    {
        id: 'ftpNavigation',
        items: [
            { id: 'currentPath', cmd: 'pwd' },
            { id: 'listFiles', cmd: 'ls' },
            { id: 'parentFolder', cmd: 'cd ..' },
            { id: 'createFolder', cmd: 'mkdir ', editable: true }
        ]
    }
];

// Scoped CLI consoles: bare subcommands (the console adds the tool name).
const CLI: Record<string, HintGroup[]> = {
    docker: [{
        id: 'docker',
        items: [
            { id: 'runningContainers', cmd: 'ps' },
            { id: 'allContainers', cmd: 'ps -a' },
            { id: 'listImages', cmd: 'images' },
            { id: 'dockerDisk', cmd: 'system df' }
        ]
    }],
    kubectl: [{
        id: 'kubectl',
        items: [
            { id: 'pods', cmd: 'get pods' },
            { id: 'kubeServices', cmd: 'get svc' },
            { id: 'nodes', cmd: 'get nodes' },
            { id: 'contexts', cmd: 'config get-contexts' }
        ]
    }],
    aws: [{
        id: 'aws',
        items: [
            { id: 'whoAmI', cmd: 'sts get-caller-identity' },
            { id: 'buckets', cmd: 's3 ls' },
            { id: 'ec2Instances', cmd: 'ec2 describe-instances' }
        ]
    }],
    azure: [{
        id: 'azure',
        items: [
            { id: 'currentAccount', cmd: 'account show --output table' },
            { id: 'resourceGroups', cmd: 'group list --output table' },
            { id: 'virtualMachines', cmd: 'vm list --output table' }
        ]
    }],
    gcloud: [{
        id: 'gcloud',
        items: [
            { id: 'gcloudConfig', cmd: 'config list' },
            { id: 'projects', cmd: 'projects list' },
            { id: 'computeInstances', cmd: 'compute instances list' }
        ]
    }]
};

export function hintGroupsFor(server: Pick<WorkspaceServer, 'type' | 'cli_preset'>): HintGroup[] {
    switch (server.type) {
        case 'local':
            return CLI[(server.cli_preset ?? '').toLowerCase()] ?? [];
        case 'windows':
            return WINDOWS;
        case 'ftp':
            return FTP;
        case 's3':
            return [];
        default:
            return LINUX;
    }
}
