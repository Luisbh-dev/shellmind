import {
    COMPOSE_ACTIONS,
    COMPOSE_FILE_ACTIONS,
    COMPOSE_SERVICE_ACTIONS,
    LOG_BACKLOG_LINES,
    isValidComposeName,
    isValidLogPath,
    type ComposeAction,
    type ComposeLogSource,
    type ComposeOverview,
    type ComposeProjectInfo,
    type ComposeTool,
    type OpsCapabilities
} from "../../shared/ops";
import { AppError } from "../errors";
import type { SshLease } from "../ssh/pool";
import type { PreparedAction } from "./actions";
import {
    COMPOSE_CONFIG_FILES,
    COMPOSE_ENV_FILE,
    COMPOSE_PROJECT,
    COMPOSE_WORKING_DIR,
    engineCommand,
    parseContainerRecords,
    requireEngine,
    type ContainerRecord,
    type Engine
} from "./containers";
import { POSIX_SECTION_FUNCTION, asNumber, commandFailure, parseSections, runPosixScript, shellQuote } from "./remote";
import { InvalidOpsInputError, OpsUnsupportedError } from "./services";

// W7-S3: Compose projects. A project is found through the labels Compose puts
// on its containers: its name, the directory `compose up` ran in and the
// config files it used. Actions run `compose -p <name>` with those files (so
// they apply the same configuration), built from validated names and quoted
// paths; the client only ever names a project, a service and an action.
// Docker Compose stops, restarts, takes down and follows the logs of a
// project by name alone, which still works when its files are gone.

const DISCOVER_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5 * 60_000;
// Pulling images can take a while on a slow link.
const UPDATE_TIMEOUT_MS = 15 * 60_000;

const PODMAN_PROJECT = "io.podman.compose.project";

function requireLinux(caps: OpsCapabilities): void {
    if (caps.platform !== "linux") throw new OpsUnsupportedError("Compose projects are available on Linux servers.");
}

export function requireComposeName(name: string, what: "project" | "service"): string {
    if (!isValidComposeName(name)) throw new InvalidOpsInputError(`"${name.slice(0, 80)}" is not a valid Compose ${what} name.`);
    return name;
}

function psArgs(target: Engine): string[] {
    const filter = ["--filter", `label=${COMPOSE_PROJECT}`];
    return target.engine === "podman" ? ["ps", "-a", ...filter, "--format", "json"] : ["ps", "-a", "--no-trunc", ...filter, "--format", "{{json .}}"];
}

// Lists the containers of every project and, for Podman, which Compose
// implementation is installed (Docker's was detected with the capabilities).
export function composeDiscoveryScript(target: Engine): string {
    const lines = [POSIX_SECTION_FUNCTION, "m ps", `${engineCommand(target, psArgs(target))} 2>&1`, "r=$?", "m rc", "echo $r"];
    if (target.engine === "podman") {
        lines.push(
            "m tool",
            "if podman compose version >/dev/null 2>&1; then echo 'podman compose'; elif command -v podman-compose >/dev/null 2>&1; then echo podman-compose; fi"
        );
    }
    lines.push("m end", "");
    return lines.join("\n");
}

// A project as its containers' labels describe it (before the files are checked).
export type DiscoveredProject = {
    name: string;
    workingDir: string | null;
    configFiles: string[];
    envFiles: string[];
    // Paths the labels name that are not usable absolute paths.
    invalidPaths: string[];
    records: ContainerRecord[];
};

const splitList = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

// Relative config files (Compose v1 wrote them as given) are relative to the
// working directory. Paths are only used once they pass the absolute-path
// rules of the log panel (no quotes, control characters or "..").
function resolvePath(path: string, workingDir: string | null): string {
    if (path.startsWith("/") || !workingDir) return path;
    return `${workingDir.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

const usablePath = (path: string) => path.startsWith("/") && isValidLogPath("linux", path);

export function groupProjects(records: ContainerRecord[]): DiscoveredProject[] {
    const byName = new Map<string, ContainerRecord[]>();
    for (const record of records) {
        const name = record.labels[COMPOSE_PROJECT] || record.labels[PODMAN_PROJECT];
        if (!name) continue;
        byName.set(name, [...(byName.get(name) ?? []), record]);
    }
    return [...byName.entries()].map(([name, members]) => {
        // The newest container has the labels of the latest `up`.
        const newest = [...members].sort((a, b) => (b.info.createdAt ?? "").localeCompare(a.info.createdAt ?? ""));
        const labels = newest.find((record) => record.labels[COMPOSE_CONFIG_FILES])?.labels ?? newest[0].labels;
        const rawDir = labels[COMPOSE_WORKING_DIR] || null;
        const invalidPaths: string[] = [];
        const workingDir = rawDir && usablePath(rawDir) ? rawDir : null;
        if (rawDir && !workingDir) invalidPaths.push(rawDir);
        const files = (value: string | undefined) => splitList(value).map((file) => resolvePath(file, workingDir)).filter((file) => {
            if (usablePath(file)) return true;
            invalidPaths.push(file);
            return false;
        });
        return {
            name,
            workingDir,
            configFiles: files(labels[COMPOSE_CONFIG_FILES]),
            envFiles: files(labels[COMPOSE_ENV_FILE]),
            invalidPaths,
            records: members.sort((a, b) => (a.info.composeService ?? "").localeCompare(b.info.composeService ?? "") || a.info.name.localeCompare(b.info.name))
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export function parseComposeDiscovery(target: Engine, output: string): { projects: DiscoveredProject[]; tool: ComposeTool | null; exitCode: number | null; raw: string } {
    const sections = parseSections(output);
    const raw = sections.get("ps") ?? "";
    let tool: ComposeTool | null = null;
    if (target.engine === "docker") tool = target.caps.containers.compose ? "docker compose" : null;
    else {
        const detected = sections.get("tool")?.trim();
        tool = detected === "podman compose" || detected === "podman-compose" ? detected : null;
    }
    return { projects: groupProjects(parseContainerRecords(target.engine, raw)), tool, exitCode: asNumber(sections.get("rc")), raw };
}

export function composeProblem(target: Engine): string {
    return target.engine === "docker"
        ? "Docker Compose (the docker compose plugin) is not installed on this server."
        : "Neither podman compose nor podman-compose is installed on this server.";
}

// What a privileged engine needs to read the files with (it reads them, not the login user).
const reader = (target: Engine) => (target.caps.containers.sudo ? "sudo -n " : "");

// Prints the paths (working directories and files) the server does not have.
export function missingPathsScript(target: Engine, projects: DiscoveredProject[]): string | null {
    const checks = new Set<string>();
    for (const project of projects) {
        if (project.workingDir) checks.add(`${reader(target)}test -d ${shellQuote(project.workingDir)} || printf '%s\\n' ${shellQuote(project.workingDir)}`);
        for (const file of [...project.configFiles, ...project.envFiles]) {
            checks.add(`${reader(target)}test -r ${shellQuote(file)} || printf '%s\\n' ${shellQuote(file)}`);
        }
    }
    return checks.size ? [...checks, ""].join("\n") : null;
}

type Discovery = { target: Engine; tool: ComposeTool | null; projects: DiscoveredProject[]; missing: Set<string> };

async function discover(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<Discovery> {
    requireLinux(caps);
    const target = requireEngine(caps);
    const options = { timeoutMs: DISCOVER_TIMEOUT_MS, signal };
    const result = await runPosixScript(lease, composeDiscoveryScript(target), options);
    const { projects, tool, exitCode, raw } = parseComposeDiscovery(target, result.stdout);
    if (exitCode !== 0) throw commandFailure({ ...result, code: exitCode, stdout: raw }, "Listing the Compose projects failed");
    const script = missingPathsScript(target, projects);
    const missing = new Set<string>();
    if (script) {
        const check = await runPosixScript(lease, script, options);
        for (const line of check.stdout.split("\n")) if (line.trim()) missing.add(line.trim());
    }
    return { target, tool, projects, missing };
}

function projectInfo(project: DiscoveredProject, missing: Set<string>): ComposeProjectInfo {
    const containers = project.records.map((record) => record.info);
    const missingFiles = [
        ...project.invalidPaths,
        ...[project.workingDir, ...project.configFiles, ...project.envFiles].filter((path): path is string => Boolean(path && missing.has(path)))
    ];
    return {
        name: project.name,
        workingDir: project.workingDir,
        configFiles: project.configFiles,
        missingFiles,
        containers,
        running: containers.filter((container) => container.state === "running").length,
        actionable: isValidComposeName(project.name)
    };
}

export async function composeOverview(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<ComposeOverview> {
    const { target, tool, projects, missing } = await discover(lease, caps, signal);
    return {
        engine: target.engine,
        tool,
        problem: tool ? null : composeProblem(target),
        projects: projects.map((project) => projectInfo(project, missing))
    };
}

// How one project is invoked: the command for a list of Compose arguments,
// and the directory the script changes to first. With usable files Docker
// Compose gets them and --project-directory; without, it works by name from /
// (where no unrelated compose.yaml can be picked up). podman-compose always
// needs the files and runs from the project's directory.
export type ComposeInvocation = { cwd: string; command: (args: string[]) => string };

export function composeInvocation(target: Engine, tool: ComposeTool, project: DiscoveredProject, needFiles: boolean, missing: Set<string>): ComposeInvocation {
    const absent = projectInfo(project, missing).missingFiles;
    const filesUsable = Boolean(project.workingDir && project.configFiles.length && absent.length === 0);
    if (!filesUsable && (needFiles || tool !== "docker compose")) {
        const files = absent.length ? absent : project.configFiles;
        throw new AppError(
            "COMPOSE_FILES_MISSING",
            files.length
                ? `The Compose files of ${project.name} are not on the server any more: ${files.join(", ")}.`
                : `ShellMind cannot tell which Compose files ${project.name} was started with.`,
            409,
            { project: project.name, files: files.join(", ") }
        );
    }
    const fileArgs = filesUsable
        ? [
            ...(tool === "docker compose" && project.workingDir ? ["--project-directory", project.workingDir] : []),
            ...project.configFiles.flatMap((file) => ["-f", file]),
            ...project.envFiles.flatMap((file) => ["--env-file", file])
        ]
        : [];
    const cwd = filesUsable && tool !== "docker compose" && project.workingDir ? project.workingDir : "/";
    const command = (args: string[]) => {
        const all = ["-p", project.name, ...fileArgs, ...args];
        if (tool === "podman-compose") return `podman-compose ${all.map(shellQuote).join(" ")}`;
        return engineCommand(target, ["compose", ...all]);
    };
    return { cwd, command };
}

function findProject(discovery: Discovery, name: string): DiscoveredProject {
    const project = discovery.projects.find((entry) => entry.name === name);
    if (!project) throw new AppError("OPS_NOT_FOUND", `The server has no Compose project named ${name}.`, 404, { project: name });
    return project;
}

function requireTool(discovery: Discovery): ComposeTool {
    if (!discovery.tool) throw new OpsUnsupportedError(composeProblem(discovery.target));
    return discovery.tool;
}

function isComposeAction(action: string): action is ComposeAction {
    return (COMPOSE_ACTIONS as readonly string[]).includes(action);
}

// The steps of an action (Compose arguments), each run only if the one before succeeded.
export function composeActionSteps(action: ComposeAction, service?: string): string[][] {
    const services = service ? [service] : [];
    switch (action) {
        case "up":
            return [["up", "-d", ...services]];
        case "update":
            return [["pull", ...services], ["up", "-d", ...services]];
        case "restart":
            return [["restart", ...services]];
        case "stop":
            return [["stop", ...services]];
        case "down":
            // Never -v or --rmi: volumes and images stay.
            return [["down"]];
    }
}

export async function prepareComposeAction(
    lease: SshLease,
    caps: OpsCapabilities,
    name: string,
    action: string,
    service: string | undefined,
    signal?: AbortSignal
): Promise<PreparedAction> {
    requireComposeName(name, "project");
    if (!isComposeAction(action)) throw new InvalidOpsInputError(`"${action.slice(0, 40)}" is not a Compose action.`);
    if (service !== undefined) {
        requireComposeName(service, "service");
        if (!COMPOSE_SERVICE_ACTIONS.includes(action)) throw new InvalidOpsInputError(`"${action}" applies to a whole project, not to one service.`);
    }
    const discovery = await discover(lease, caps, signal);
    const tool = requireTool(discovery);
    const project = findProject(discovery, name);
    const invocation = composeInvocation(discovery.target, tool, project, COMPOSE_FILE_ACTIONS.includes(action), discovery.missing);
    const commands = composeActionSteps(action, service).map(invocation.command);
    // Compose prints its progress on stderr: it is the output of the action.
    const script = [`cd ${shellQuote(invocation.cwd)} || exit 1`, commands.map((command) => `${command} 2>&1`).join(" && "), ""].join("\n");
    return {
        display: commands.join(" && "),
        meta: { kind: "compose", action, target: name, ...(service ? { service } : {}) },
        run: (runLease, runSignal) => runPosixScript(runLease, script, { timeoutMs: action === "update" ? UPDATE_TIMEOUT_MS : ACTION_TIMEOUT_MS, signal: runSignal })
    };
}

// The command of a live log stream of a project (see server/sockets/logs.ts),
// before the watchdog wraps it: `exec` makes the engine the process the
// watchdog stops.
export async function composeLogCommand(lease: SshLease, caps: OpsCapabilities, source: ComposeLogSource, signal?: AbortSignal): Promise<string> {
    requireComposeName(source.project, "project");
    if (source.service) requireComposeName(source.service, "service");
    const discovery = await discover(lease, caps, signal);
    const tool = requireTool(discovery);
    const project = findProject(discovery, source.project);
    const invocation = composeInvocation(discovery.target, tool, project, false, discovery.missing);
    const args = ["logs", "-f", "--tail", String(LOG_BACKLOG_LINES), "--timestamps", ...(source.service ? [source.service] : [])];
    return `cd ${shellQuote(invocation.cwd)} && exec ${invocation.command(args)}`;
}
