import type { CleanupId, CleanupParams, CleanupPreview } from "../../../shared/disk";
import type { DiskUsage, ImageInfo, PruneMode } from "../../../shared/ops";
import { AppError, errorMessage } from "../../errors";
import type { PreparedAction } from "../../ops/actions";
import { engineCommand, listContainers, requireEngine, runEngine, type Engine } from "../../ops/containers";
import { diskUsage, estimatePrune, listImages, parsePruneOutput, preparePrune, pruneCandidates, prunePreview } from "../../ops/images";
import { runPosixScript } from "../../ops/remote";
import { topItems, type CleanupContext, type CleanupProvider, type PreparedCleanup } from "./types";

// The container engine's own cleanups, reusing the image and build-cache
// prunes of the operations panels (server/ops/images.ts) and adding the
// removal of stopped containers. The overview reads the image list and
// `system df` once for all of them; the preview of one image prune asks the
// engine for the space only those images hold.

export const DOCKER_CLEANUPS = ["docker-dangling", "docker-unused", "docker-build-cache", "docker-containers"] as const;
type DockerCleanupId = typeof DOCKER_CLEANUPS[number];

const PRUNE_MODE: Partial<Record<DockerCleanupId, PruneMode>> = {
    "docker-dangling": "dangling",
    "docker-unused": "unused",
    "docker-build-cache": "build-cache"
};

const STOPPED = new Set(["exited", "created", "dead"]);
const ROOT_TIMEOUT_MS = 20_000;
const CONTAINER_PRUNE_TIMEOUT_MS = 5 * 60_000;
const CONTAINER_PRUNE_ARGS = ["container", "prune", "-f"];

// Where the engine keeps its data, and the filesystem that is on.
export function engineRootScript(target: Engine): string {
    const format = target.engine === "podman" ? "{{.Store.GraphRoot}}" : "{{.DockerRootDir}}";
    return [
        `d=$(${engineCommand(target, ["info", "--format", format])} 2>/dev/null)`,
        "[ -n \"$d\" ] && printf '%s\\t%s\\n' \"$d\" \"$(df -P -- \"$d\" 2>/dev/null | awk 'NR == 2 { for (i = 6; i <= NF; i++) printf \"%s%s\", $i, (i < NF ? \" \" : \"\") }')\"",
        ""
    ].join("\n");
}

async function engineMount(ctx: CleanupContext, target: Engine): Promise<string[]> {
    const result = await runPosixScript(ctx.lease, engineRootScript(target), { timeoutMs: ROOT_TIMEOUT_MS, signal: ctx.signal });
    const mount = result.stdout.trim().split("\t")[1];
    return mount && ctx.mounts.some((entry) => entry.mount === mount) ? [mount] : [];
}

const imageItems = (images: ImageInfo[]) => topItems(images.map((image) => ({ label: image.reference ?? image.id.replace(/^sha256:/, "").slice(0, 12), bytes: image.size })));

function imagePreview(id: DockerCleanupId, mode: PruneMode, images: ImageInfo[], usage: DiskUsage, command: string, mounts: string[]): CleanupPreview {
    const candidates = pruneCandidates(images, mode);
    const { bytes, estimate } = estimatePrune(mode, candidates, usage);
    const count = mode === "build-cache" ? null : candidates.length;
    const something = mode === "build-cache" ? (bytes ?? 0) > 0 : candidates.length > 0;
    return { id, status: something ? "ready" : "nothing", bytes, estimate, count, items: mode === "build-cache" ? [] : imageItems(candidates), mounts, command, params: {} };
}

function unavailable(id: DockerCleanupId, command: string, err: unknown): CleanupPreview {
    return { id, status: "unavailable", reason: { code: "NO_ENGINE", message: errorMessage(err).slice(0, 500) }, bytes: null, estimate: "about", count: null, items: [], mounts: [], command, params: {} };
}

function commandOf(target: Engine, id: DockerCleanupId): string {
    const mode = PRUNE_MODE[id];
    return mode ? preparePrune(target.caps, mode).display : engineCommand(target, CONTAINER_PRUNE_ARGS);
}

// The engine's cleanups this server can have: none without an engine, the
// build cache with Docker only.
function idsFor(target: Engine): DockerCleanupId[] {
    return DOCKER_CLEANUPS.filter((id) => id !== "docker-build-cache" || target.engine === "docker");
}

async function containersPreview(ctx: CleanupContext, target: Engine, usage: DiskUsage | null, mounts: string[]): Promise<CleanupPreview> {
    const list = await listContainers(ctx.lease, target.caps, ctx.signal);
    const stopped = list.containers.filter((container) => STOPPED.has(container.state));
    const row = usage?.rows.find((entry) => entry.kind === "containers");
    return {
        id: "docker-containers",
        status: stopped.length ? "ready" : "nothing",
        bytes: stopped.length ? row?.reclaimable ?? null : 0,
        estimate: "about",
        count: stopped.length,
        items: stopped.slice(0, 50).map((container) => ({ label: `${container.name} (${container.image})`, bytes: null })),
        mounts,
        command: engineCommand(target, CONTAINER_PRUNE_ARGS),
        params: {}
    };
}

function requireDockerId(id: CleanupId): DockerCleanupId {
    if (!(DOCKER_CLEANUPS as readonly string[]).includes(id)) throw new AppError("OPS_UNSUPPORTED", `${id} is not a container engine cleanup.`, 409);
    return id as DockerCleanupId;
}

export const dockerCleanups: CleanupProvider = {
    ids: DOCKER_CLEANUPS,
    overview: async (ctx) => {
        if (ctx.caps.platform !== "linux" || !ctx.caps.containers.engine) return [];
        const target = requireEngine(ctx.caps);
        const ids = idsFor(target);
        const [images, usage, mounts] = await Promise.allSettled([
            listImages(ctx.lease, ctx.caps, ctx.signal),
            diskUsage(ctx.lease, ctx.caps, ctx.signal),
            engineMount(ctx, target)
        ]);
        const where = mounts.status === "fulfilled" ? mounts.value : [];
        const df = usage.status === "fulfilled" ? usage.value : null;
        const previews: CleanupPreview[] = [];
        for (const id of ids) {
            const mode = PRUNE_MODE[id];
            const command = commandOf(target, id);
            if (!mode) {
                previews.push(await containersPreview(ctx, target, df, where).catch((err: unknown) => unavailable(id, command, err)));
                continue;
            }
            if (mode !== "build-cache" && images.status === "rejected") previews.push(unavailable(id, command, images.reason));
            else if (!df && mode === "build-cache") previews.push(unavailable(id, command, usage.status === "rejected" ? usage.reason : "system df failed"));
            else previews.push(imagePreview(id, mode, images.status === "fulfilled" ? images.value.images : [], df ?? { rows: [], uniqueSizes: {} }, command, where));
        }
        return previews;
    },
    preview: async (ctx, id, _params: CleanupParams) => {
        const cleanup = requireDockerId(id);
        const target = requireEngine(ctx.caps);
        if (!idsFor(target).includes(cleanup)) throw new AppError("OPS_UNSUPPORTED", "Pruning the build cache needs Docker.", 409);
        const mounts = await engineMount(ctx, target).catch(() => []);
        const mode = PRUNE_MODE[cleanup];
        const command = commandOf(target, cleanup);
        if (!mode) return containersPreview(ctx, target, await diskUsage(ctx.lease, ctx.caps, ctx.signal).catch(() => null), mounts);
        const preview = await prunePreview(ctx.lease, ctx.caps, mode, ctx.signal);
        const something = mode === "build-cache" ? (preview.bytes ?? 0) > 0 : preview.images.length > 0;
        return {
            id: cleanup,
            status: something ? "ready" : "nothing",
            bytes: preview.bytes,
            estimate: preview.estimate,
            count: mode === "build-cache" ? null : preview.images.length,
            items: imageItems(preview.images),
            mounts,
            command,
            params: {}
        };
    },
    prepare: async (ctx, id, params): Promise<PreparedCleanup> => {
        const cleanup = requireDockerId(id);
        const preview = await dockerCleanups.preview(ctx, cleanup, params);
        const mode = PRUNE_MODE[cleanup];
        const target = requireEngine(ctx.caps);
        const prune: PreparedAction = mode
            ? preparePrune(ctx.caps, mode)
            : { display: preview.command, meta: { kind: "image", action: "prune-containers", target: "stopped" }, run: (lease, signal) => runEngine(lease, target, CONTAINER_PRUNE_ARGS, { timeoutMs: CONTAINER_PRUNE_TIMEOUT_MS, signal }) };
        return {
            preview,
            action: { ...prune, meta: { kind: "disk", action: `cleanup-${cleanup}`, target: preview.mounts.join(", ") || target.engine } },
            reported: (output) => parsePruneOutput(output).reclaimedBytes
        };
    }
};
