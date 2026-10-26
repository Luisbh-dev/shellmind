import { findDangerousCommand, type DangerReason } from "../../shared/commandSafety";
import {
    DEFAULT_STRATEGY,
    MULTIEXEC_LIMITS,
    MULTIEXEC_SERVER_TYPES,
    type MultiExecStrategy,
    type MultiExecTarget
} from "../../shared/multiexec";
import {
    fillPlaceholders,
    maskPlaceholders,
    missingVariables,
    parsePlaceholders,
    rewriteAroundPlaceholders,
    secretValues,
    secretVariableNames
} from "../../shared/placeholders";
import { SNIPPET_LIMITS } from "../../shared/snippets";
import type { AuditSource } from "../../shared/types";
import { redactSecrets } from "../ai/redact";
import { serversRepo } from "../db/serversRepo";
import { AppError } from "../errors";
import type { ServerStep } from "./runner";
import { maskSecretValues, type SecretValue } from "./secretMasker";

// Checks a POST /api/multiexec body and works out what runs and what is
// recorded. A template with variables is filled in here, so the recorded
// form (audit log, job history) is derived from exactly what runs: secret
// variables keep their {{placeholder}} there, their values only reach the
// servers. Secret-looking text the user typed is masked in the record too
// (best effort, redactSecrets), in the command and in the template.

export type JobRequest = {
    // What runs on the servers.
    command: string;
    // What is recorded (see above), and whether it differs from `command`.
    recorded: string;
    masked: boolean;
    // The template as recorded, and whether redaction changed it.
    template: string | null;
    templateMasked: boolean;
    // Values of the template's non-secret variables.
    variables: Record<string, string> | null;
    secretVariables: string[];
    // Masked in the output.
    secrets: SecretValue[];
    targets: MultiExecTarget[];
    timeoutSec: number;
    strategy: MultiExecStrategy;
    snippet: { id: number | null; name: string } | null;
    danger: DangerReason | null;
    rerunOf: string | null;
    // W8-T3: jobs built by other features (the patch center), never from a
    // POST /api/multiexec body: what runs on each server instead of
    // `command`, and how the audit log records it.
    step?: ServerStep;
    auditSource?: AuditSource;
    auditCommand?: string;
    auditMeta?: Record<string, unknown>;
};

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isJobId = (value: unknown): value is string => typeof value === "string" && JOB_ID.test(value);

function invalid(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("INVALID_MULTIEXEC", message, 400, details);
}

function boundedInt(value: unknown, name: string, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw invalid(`${name} must be an integer from ${min} to ${max}`, { field: name });
    }
    return value;
}

function optionalInt(value: unknown, name: string, max: number): number | null {
    return value === undefined || value === null ? null : boundedInt(value, name, 1, max, 0);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseSnippet(value: unknown): JobRequest["snippet"] {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) throw invalid("snippet must be an object");
    const { id, name } = value;
    if (typeof name !== "string" || !name.trim() || name.length > SNIPPET_LIMITS.name) throw invalid("snippet.name is required");
    if (id !== undefined && id !== null && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
        throw invalid("snippet.id must be a positive integer");
    }
    return { id: typeof id === "number" ? id : null, name: name.trim() };
}

export function parseStrategy(value: unknown, concurrency: unknown, targets: number): MultiExecStrategy {
    if (value !== undefined && value !== null && !isRecord(value)) throw invalid("strategy must be an object");
    const input = value ?? {};
    const strategy: MultiExecStrategy = {
        concurrency: boundedInt(input.concurrency ?? concurrency, "concurrency", 1, MULTIEXEC_LIMITS.maxConcurrency, DEFAULT_STRATEGY.concurrency),
        batch: null,
        pauseSec: boundedInt(input.pauseSec, "strategy.pauseSec", 0, MULTIEXEC_LIMITS.maxPauseSec, 0),
        canary: null,
        failureLimit: null
    };

    if (input.batch !== undefined && input.batch !== null) {
        if (!isRecord(input.batch)) throw invalid("strategy.batch must be an object");
        const unit = input.batch.unit;
        if (unit !== "servers" && unit !== "percent") throw invalid("strategy.batch.unit must be \"servers\" or \"percent\"", { field: "strategy.batch.unit" });
        const max = unit === "percent" ? 100 : MULTIEXEC_LIMITS.maxTargets;
        if (input.batch.size === undefined || input.batch.size === null) throw invalid("strategy.batch.size is required", { field: "strategy.batch.size" });
        strategy.batch = { unit, size: boundedInt(input.batch.size, "strategy.batch.size", 1, max, 1) };
    }

    if (input.canary !== undefined && input.canary !== null) {
        if (!isRecord(input.canary)) throw invalid("strategy.canary must be an object");
        const onSuccess = input.canary.onSuccess ?? "pause";
        if (onSuccess !== "pause" && onSuccess !== "continue") throw invalid("strategy.canary.onSuccess must be \"pause\" or \"continue\"", { field: "strategy.canary.onSuccess" });
        const count = boundedInt(input.canary.count, "strategy.canary.count", 1, MULTIEXEC_LIMITS.maxTargets, 1);
        if (count >= targets) throw invalid("The canary must be smaller than the number of servers", { field: "strategy.canary.count" });
        strategy.canary = { count, onSuccess };
    }

    if (input.failureLimit !== undefined && input.failureLimit !== null) {
        if (!isRecord(input.failureLimit)) throw invalid("strategy.failureLimit must be an object");
        const count = optionalInt(input.failureLimit.count, "strategy.failureLimit.count", MULTIEXEC_LIMITS.maxTargets);
        const percent = optionalInt(input.failureLimit.percent, "strategy.failureLimit.percent", 100);
        strategy.failureLimit = count === null && percent === null ? null : { count, percent };
    }
    return strategy;
}

function parseVariables(value: unknown): Record<string, string> | null {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) throw invalid("variables must be an object of strings");
    const entries = Object.entries(value);
    if (entries.length > MULTIEXEC_LIMITS.maxVariables) throw invalid(`at most ${MULTIEXEC_LIMITS.maxVariables} variables`);
    for (const [name, text] of entries) {
        if (!/^[A-Za-z_][\w-]*$/.test(name)) throw invalid(`"${name.slice(0, 40)}" is not a variable name`);
        if (typeof text !== "string" || text.length > MULTIEXEC_LIMITS.maxVariableLength || text.includes("\u0000")) {
            throw invalid(`The value of ${name} must be text of up to ${MULTIEXEC_LIMITS.maxVariableLength} characters`);
        }
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

function parseNames(value: unknown, field: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MULTIEXEC_LIMITS.maxVariables || value.some((name) => typeof name !== "string")) {
        throw invalid(`${field} must be a list of variable names`);
    }
    return value as string[];
}

// Secret-looking text typed into a command or template masked, its
// placeholders kept (a secret variable's `{{name}}` in the recorded command
// is not a credential). When a pattern takes a placeholder for part of a
// secret (`https://u:{{pw}}@host`), the text is masked as a whole,
// placeholders included.
const redactAroundPlaceholders = (text: string): string => rewriteAroundPlaceholders(text, redactSecrets) ?? redactSecrets(text);

// The template as the job history keeps it, masked as the recorded command is.
function recordedTemplate(source: string): { template: string; masked: boolean } {
    const template = redactAroundPlaceholders(source);
    return { template, masked: template !== source };
}

async function resolveTargets(value: unknown): Promise<MultiExecTarget[]> {
    if (!Array.isArray(value) || value.length === 0) throw invalid("serverIds must list at least one server");
    const ids = [...new Set(value as unknown[])];
    if (ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) throw invalid("serverIds must be positive integers");
    if (ids.length > MULTIEXEC_LIMITS.maxTargets) throw invalid(`at most ${MULTIEXEC_LIMITS.maxTargets} servers per job`);

    const targets: MultiExecTarget[] = [];
    const missing: number[] = [];
    const unsupported: number[] = [];
    for (const id of ids as number[]) {
        const server = await serversRepo.getSummary(id);
        if (!server) missing.push(id);
        else if (!MULTIEXEC_SERVER_TYPES.includes(server.type)) unsupported.push(id);
        else targets.push({ serverId: id, name: server.name, host: server.ip, type: server.type });
    }
    if (missing.length) throw invalid(`server ${missing.map((id) => `#${id}`).join(", ")} does not exist`, { missing });
    if (unsupported.length) {
        throw invalid(`multi-exec only runs on SSH servers (${MULTIEXEC_SERVER_TYPES.join(", ")})`, { unsupported });
    }
    return targets;
}

export async function parseJobRequest(body: Record<string, unknown>): Promise<JobRequest> {
    if (typeof body.command !== "string" || !body.command.trim()) throw invalid("command is required");
    const source = body.command.replace(/\r\n?/g, "\n").trimEnd();
    if (source.length > MULTIEXEC_LIMITS.maxCommandLength) throw invalid(`command is longer than ${MULTIEXEC_LIMITS.maxCommandLength} characters`);

    const given = parseVariables(body.variables);
    const marked = parseNames(body.secretVariables, "secretVariables");
    const unmarked = parseNames(body.publicVariables, "publicVariables");
    let command = source;
    let recorded = source;
    let template: string | null = null;
    let templateMasked = false;
    let variables: Record<string, string> | null = null;
    let secretVariables: string[] = [];
    let secrets: SecretValue[] = [];
    if (given) {
        const declared = parsePlaceholders(source);
        const missing = missingVariables(declared, given);
        if (missing.length) throw invalid(`Fill in: ${missing.join(", ")}`, { missingVariables: missing });
        const secret = secretVariableNames(source, { marked, unmarked });
        command = fillPlaceholders(source, given);
        if (!command.trim()) throw invalid("command is required");
        if (command.length > MULTIEXEC_LIMITS.maxCommandLength) throw invalid(`command is longer than ${MULTIEXEC_LIMITS.maxCommandLength} characters once filled in`);
        recorded = maskPlaceholders(source, given, secret);
        ({ template, masked: templateMasked } = recordedTemplate(source));
        variables = Object.fromEntries(declared.filter((variable) => !secret.has(variable.name) && given[variable.name] !== undefined)
            .map((variable) => [variable.name, given[variable.name]]));
        secretVariables = [...secret];
        secrets = secretValues(given, secret);
    }
    recorded = redactAroundPlaceholders(recorded);

    const targets = await resolveTargets(body.serverIds);
    const strategy = parseStrategy(body.strategy, body.concurrency, targets.length);

    const danger = findDangerousCommand(command);
    if (danger && body.confirmDangerous !== true) {
        throw new AppError("DANGEROUS_COMMAND", "This command looks destructive: confirm it before it runs.", 409, {
            reason: danger.reason,
            line: redactSecrets(maskSecretValues(danger.line, secrets))
        });
    }

    if (body.rerunOf !== undefined && body.rerunOf !== null && !isJobId(body.rerunOf)) throw invalid("rerunOf must be a job id");

    return {
        command,
        recorded,
        masked: recorded !== command,
        template,
        templateMasked,
        variables,
        secretVariables,
        secrets,
        targets,
        timeoutSec: boundedInt(body.timeoutSec, "timeoutSec", 1, MULTIEXEC_LIMITS.maxTimeoutSec, MULTIEXEC_LIMITS.defaultTimeoutSec),
        strategy,
        snippet: parseSnippet(body.snippet),
        danger: danger?.reason ?? null,
        rerunOf: typeof body.rerunOf === "string" ? body.rerunOf : null
    };
}
