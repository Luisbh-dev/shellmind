// Local CLI presets (servers of type "local" with a cli_preset).

// Common subcommands per tool, used for Tab-completion in the scoped console.
export const CLI_SUBCOMMANDS: Record<string, string[]> = {
    docker: ["ps", "images", "pull", "push", "run", "exec", "logs", "build", "compose", "network", "volume", "inspect", "stop", "start", "restart", "rm", "rmi", "stats", "system", "login", "info", "version", "top", "cp", "tag", "save", "load"],
    kubectl: ["get", "describe", "apply", "delete", "logs", "exec", "config", "rollout", "scale", "port-forward", "top", "version", "cluster-info", "create", "edit", "explain", "expose", "run", "cordon", "drain"],
    aws: ["s3", "ec2", "sts", "iam", "lambda", "dynamodb", "cloudformation", "logs", "configure", "ecr", "ecs", "eks", "ssm", "rds", "route53", "sns", "sqs", "cloudwatch"],
    az: ["account", "group", "vm", "storage", "login", "logout", "aks", "webapp", "network", "ad", "keyvault", "acr", "appservice", "functionapp", "sql", "cosmosdb", "monitor", "role", "version"],
    gcloud: ["config", "compute", "auth", "projects", "container", "storage", "app", "functions", "run", "sql", "iam", "logging", "services", "components"]
};

// Known CLI presets → the binary we expect on PATH + official install docs.
export const CLI_PRESET_INFO: Record<string, { bin: string; name: string; url: string }> = {
    azure: { bin: "az", name: "Azure CLI", url: "https://learn.microsoft.com/cli/azure/install-azure-cli" },
    aws: { bin: "aws", name: "AWS CLI", url: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" },
    gcloud: { bin: "gcloud", name: "Google Cloud CLI", url: "https://cloud.google.com/sdk/docs/install" },
    kubectl: { bin: "kubectl", name: "kubectl", url: "https://kubernetes.io/docs/tasks/tools/" },
    docker: { bin: "docker", name: "Docker", url: "https://docs.docker.com/get-docker/" }
};

// --- slice V4b: the cli_preset values a local server may be saved with -------

// "shell" opens the system shell and "custom" the configured command; the
// others are the scoped consoles of CLI_PRESET_INFO.
export const CLI_PRESET_KEYS: readonly string[] = ["shell", ...Object.keys(CLI_PRESET_INFO), "custom"];

// The stored form of a preset ("Docker " -> "docker"), or null when it is not
// one ShellMind knows. An unknown preset must never fall back to a full shell.
export function normalizeCliPreset(value: string): string | null {
    const key = value.trim().toLowerCase();
    return CLI_PRESET_KEYS.includes(key) ? key : null;
}
