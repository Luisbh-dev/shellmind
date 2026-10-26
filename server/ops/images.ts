import {
    PRUNE_MODES,
    isValidImageRef,
    type DiskUsage,
    type DiskUsageKind,
    type DiskUsageRow,
    type ImageInfo,
    type ImageList,
    type OpsCapabilities,
    type PruneMode,
    type PrunePreview
} from "../../shared/ops";
import type { SshLease } from "../ssh/pool";
import type { PreparedAction } from "./actions";
import { engineCommand, jsonLines, requireEngine, runEngine, type Engine } from "./containers";
import {
    POSIX_SECTION_FUNCTION,
    asNumber,
    asString,
    commandFailure,
    ensureArray,
    extractJson,
    isRecord,
    parseSections,
    runPosixScript
} from "./remote";
import { InvalidOpsInputError, OpsUnsupportedError } from "./services";

// W7-S3: images and the disk space of the container engine. The list marks
// what `image prune` would remove (dangling) and what no container uses;
// prunes are previewed with the space they free before anything is removed.

const LIST_TIMEOUT_MS = 30_000;
// `system df` sizes every container's writable layer: slow on a busy host.
const DF_TIMEOUT_MS = 90_000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
const PRUNE_TIMEOUT_MS = 10 * 60_000;

function requireLinux(caps: OpsCapabilities): void {
    if (caps.platform !== "linux") throw new OpsUnsupportedError("Image management is available on Linux servers.");
}

const UNITS: Record<string, number> = {
    b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5
};

// "4.42MB", "16.1kB", "1.2GB (45%)", "8B" -> bytes (Docker prints decimal
// units; binary ones are accepted too). A number is already bytes (Podman).
export function parseSize(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    const match = /^\s*([\d.]+)\s*([kmgtp]?i?b)\b/i.exec(asString(value));
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    const unit = UNITS[match[2].toLowerCase()];
    return Number.isFinite(number) && unit ? Math.round(number * unit) : null;
}

// Docker prints "sha256:<hex>", Podman the bare hex.
export const normalizeImageId = (id: string) => (id.startsWith("sha256:") ? id : `sha256:${id}`);

const NONE = "<none>";

export function imageListScript(target: Engine): string {
    const list = target.engine === "podman"
        ? engineCommand(target, ["image", "ls", "-a", "--format", "json"])
        : engineCommand(target, ["image", "ls", "-a", "--no-trunc", "--format", "{{json .}}"]);
    return [
        POSIX_SECTION_FUNCTION,
        "m images",
        `${list} 2>&1`,
        "r=$?",
        "m rc",
        "echo $r",
        "m dangling",
        `${engineCommand(target, ["image", "ls", "-q", "--no-trunc", "--filter", "dangling=true"])} 2>/dev/null`,
        // The image of every container, running or not.
        "m used",
        `${engineCommand(target, ["ps", "-aq", "--no-trunc"])} 2>/dev/null | xargs -r ${engineCommand(target, ["inspect", "--format", "{{.Image}}"])} 2>/dev/null`,
        "m end",
        ""
    ].join("\n");
}

type RawImage = { id: string; repository: string | null; tag: string | null; size: number | null; createdAt: string | null; createdSince: string | null };

function dockerImages(raw: string): RawImage[] {
    return jsonLines(raw).flatMap((item) => {
        const id = asString(item.ID);
        if (!id) return [];
        const repository = asString(item.Repository);
        const tag = asString(item.Tag);
        return [{
            id: normalizeImageId(id),
            repository: repository && repository !== NONE ? repository : null,
            tag: tag && tag !== NONE ? tag : null,
            size: parseSize(item.Size),
            createdAt: asString(item.CreatedAt) || null,
            createdSince: asString(item.CreatedSince) || null
        }];
    });
}

// Podman 5 prints an image once per name, and every one of those entries
// carries all its names ("docker.io/library/nginx:1.25"; RepoTags is null):
// entries are merged by id, then listed once per name, as Docker does.
function podmanImages(raw: string): RawImage[] {
    const byId = new Map<string, { item: Record<string, unknown>; names: Set<string> }>();
    for (const item of ensureArray(extractJson(raw)).filter(isRecord)) {
        const id = asString(item.Id) || asString(item.ID);
        if (!id) continue;
        const entry = byId.get(normalizeImageId(id)) ?? { item, names: new Set<string>() };
        for (const name of [...ensureArray(item.RepoTags), ...ensureArray(item.Names)].map(asString)) {
            if (name && !name.startsWith(NONE)) entry.names.add(name);
        }
        byId.set(normalizeImageId(id), entry);
    }
    return [...byId.entries()].flatMap(([id, { item, names }]): RawImage[] => {
        const created = asNumber(item.Created);
        const base = {
            id,
            size: parseSize(item.Size),
            createdAt: created ? new Date(created * 1000).toISOString() : asString(item.CreatedAt) || null,
            createdSince: null
        };
        if (!names.size) return [{ ...base, repository: null, tag: null }];
        return [...names].sort().map((name) => {
            const colon = name.lastIndexOf(":");
            const hasTag = colon > name.lastIndexOf("/");
            return { ...base, repository: hasTag ? name.slice(0, colon) : name, tag: hasTag ? name.slice(colon + 1) : null };
        });
    });
}

const lines = (text: string | undefined) => (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

export function parseImageList(target: Engine, output: string): { list: ImageList; exitCode: number | null; raw: string } {
    const sections = parseSections(output);
    const raw = sections.get("images") ?? "";
    const dangling = new Set(lines(sections.get("dangling")).map(normalizeImageId));
    const used = new Map<string, number>();
    for (const id of lines(sections.get("used")).map(normalizeImageId)) used.set(id, (used.get(id) ?? 0) + 1);
    const images: ImageInfo[] = (target.engine === "podman" ? podmanImages(raw) : dockerImages(raw))
        // Untagged images that are neither dangling nor used are the
        // intermediate layers of the classic builder: not theirs to manage.
        .filter((image) => image.repository || dangling.has(image.id) || used.has(image.id))
        .map((image) => ({
            ...image,
            reference: image.repository ? (image.tag ? `${image.repository}:${image.tag}` : image.repository) : null,
            containers: used.get(image.id) ?? 0,
            // An untagged image a container still uses (its tag moved to a
            // newer pull) is not something `image prune` removes.
            dangling: dangling.has(image.id) && !used.has(image.id)
        }))
        .sort((a, b) => Number(b.dangling) - Number(a.dangling) || (a.reference ?? "~").localeCompare(b.reference ?? "~"));
    return { list: { engine: target.engine, images }, exitCode: asNumber(sections.get("rc")), raw };
}

export async function listImages(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<ImageList> {
    requireLinux(caps);
    const target = requireEngine(caps);
    const result = await runPosixScript(lease, imageListScript(target), { timeoutMs: LIST_TIMEOUT_MS, signal });
    const { list, exitCode, raw } = parseImageList(target, result.stdout);
    if (exitCode !== 0) throw commandFailure({ ...result, code: exitCode, stdout: raw }, "Listing images failed");
    return list;
}

const DF_KINDS: Record<string, DiskUsageKind> = {
    images: "images",
    containers: "containers",
    "local volumes": "volumes",
    volumes: "volumes",
    "build cache": "build-cache"
};

// `system df --format '{{json .}}'` (Docker: one object per line, sizes as
// text) or `--format json` (Podman: one array).
export function parseDiskUsageRows(raw: string): DiskUsageRow[] {
    const items = raw.trim().startsWith("[") ? ensureArray(extractJson(raw)).filter(isRecord) : jsonLines(raw);
    return items.flatMap((item) => {
        const kind = DF_KINDS[asString(item.Type).toLowerCase()];
        if (!kind) return [];
        return [{
            kind,
            count: asNumber(item.TotalCount ?? item.Total),
            active: asNumber(item.Active),
            size: parseSize(item.RawSize ?? item.Size),
            reclaimable: parseSize(item.RawReclaimable ?? item.Reclaimable)
        }];
    });
}

// `system df -v --format '{{json .}}'` (Docker 23+): the space only each image holds.
export function parseUniqueSizes(raw: string | undefined): Record<string, number> {
    const report = extractJson(raw ?? "");
    const sizes: Record<string, number> = {};
    if (!isRecord(report)) return sizes;
    for (const image of ensureArray(report.Images).filter(isRecord)) {
        const id = asString(image.ID);
        const unique = parseSize(image.UniqueSize);
        if (id && unique !== null) sizes[normalizeImageId(id)] = unique;
    }
    return sizes;
}

export function diskUsageScript(target: Engine, verbose: boolean): string {
    const summary = target.engine === "podman"
        ? engineCommand(target, ["system", "df", "--format", "json"])
        : engineCommand(target, ["system", "df", "--format", "{{json .}}"]);
    return [
        POSIX_SECTION_FUNCTION,
        "m summary",
        `${summary} 2>&1`,
        "r=$?",
        "m rc",
        "echo $r",
        // Older engines refuse --format with -v: then there are no unique sizes.
        ...(verbose && target.engine === "docker"
            ? ["m verbose", `${engineCommand(target, ["system", "df", "-v", "--format", "{{json .}}"])} 2>/dev/null`]
            : []),
        "m end",
        ""
    ].join("\n");
}

async function readDiskUsage(lease: SshLease, target: Engine, verbose: boolean, signal?: AbortSignal): Promise<DiskUsage> {
    const result = await runPosixScript(lease, diskUsageScript(target, verbose), { timeoutMs: DF_TIMEOUT_MS, signal });
    const sections = parseSections(result.stdout);
    const raw = sections.get("summary") ?? "";
    if (asNumber(sections.get("rc")) !== 0) throw commandFailure({ ...result, code: asNumber(sections.get("rc")), stdout: raw }, "Reading the disk usage failed");
    return { rows: parseDiskUsageRows(raw), uniqueSizes: parseUniqueSizes(sections.get("verbose")) };
}

export async function diskUsage(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<DiskUsage> {
    requireLinux(caps);
    return readDiskUsage(lease, requireEngine(caps), false, signal);
}

function requirePruneMode(caps: OpsCapabilities, mode: string): PruneMode {
    if (!(PRUNE_MODES as readonly string[]).includes(mode)) throw new InvalidOpsInputError(`"${mode.slice(0, 40)}" is not a prune mode.`);
    if (mode === "build-cache" && caps.containers.engine !== "docker") throw new OpsUnsupportedError("Pruning the build cache needs Docker.");
    return mode as PruneMode;
}

// One entry per image (an image with several tags is listed once).
function distinctImages(images: ImageInfo[]): ImageInfo[] {
    const seen = new Set<string>();
    return images.filter((image) => (seen.has(image.id) ? false : (seen.add(image.id), true)));
}

export function pruneCandidates(images: ImageInfo[], mode: PruneMode): ImageInfo[] {
    if (mode === "build-cache") return [];
    return distinctImages(images.filter((image) => (mode === "dangling" ? image.dangling : image.containers === 0)));
}

// What the prune frees: the layers only those images hold when the engine
// reports them (at least that much; layers they share only with each other
// go too), else at most the sum of their sizes.
export function estimatePrune(mode: PruneMode, candidates: ImageInfo[], usage: DiskUsage): Pick<PrunePreview, "bytes" | "estimate"> {
    if (mode === "build-cache") {
        return { bytes: usage.rows.find((row) => row.kind === "build-cache")?.reclaimable ?? null, estimate: "exact" };
    }
    if (candidates.length && candidates.every((image) => usage.uniqueSizes[image.id] !== undefined)) {
        return { bytes: candidates.reduce((sum, image) => sum + usage.uniqueSizes[image.id], 0), estimate: "at-least" };
    }
    return { bytes: candidates.reduce((sum, image) => sum + (image.size ?? 0), 0), estimate: "up-to" };
}

export async function prunePreview(lease: SshLease, caps: OpsCapabilities, modeName: string, signal?: AbortSignal): Promise<PrunePreview> {
    requireLinux(caps);
    const mode = requirePruneMode(caps, modeName);
    const target = requireEngine(caps);
    const images = mode === "build-cache" ? [] : (await listImages(lease, caps, signal)).images;
    const candidates = pruneCandidates(images, mode);
    const usage = mode === "build-cache" || candidates.length ? await readDiskUsage(lease, target, mode !== "build-cache", signal) : { rows: [], uniqueSizes: {} };
    return { mode, images: candidates, ...estimatePrune(mode, candidates, usage) };
}

const PRUNE_ARGS: Record<PruneMode, string[]> = {
    dangling: ["image", "prune", "-f"],
    unused: ["image", "prune", "-a", "-f"],
    // The cache no build uses and no image shares: what `system df` counts as
    // reclaimable, and its "Total" is then the space freed. With -a the
    // records images share would go too, freeing nothing (the images keep
    // those layers) while adding their size to the "Total".
    "build-cache": ["builder", "prune", "-f"]
};

export function preparePrune(caps: OpsCapabilities, modeName: string): PreparedAction {
    requireLinux(caps);
    const mode = requirePruneMode(caps, modeName);
    const target = requireEngine(caps);
    const args = PRUNE_ARGS[mode];
    return {
        display: engineCommand(target, args),
        meta: { kind: "image", action: `prune-${mode}`, target: mode },
        run: (lease, signal) => runEngine(lease, target, args, { timeoutMs: PRUNE_TIMEOUT_MS, signal })
    };
}

// "Total reclaimed space: 1.2GB" (image prune) or "Total: 2.9GB" (builder
// prune); Podman reports no total.
export function parsePruneOutput(output: string): { reclaimedBytes: number | null } {
    const total = /Total(?: reclaimed space)?:\s*([\d.]+\s*[kKMGTP]?i?B)/.exec(output);
    return { reclaimedBytes: total ? parseSize(total[1]) : null };
}

export function prepareImageRemoval(caps: OpsCapabilities, ref: unknown): PreparedAction {
    requireLinux(caps);
    const target = requireEngine(caps);
    if (typeof ref !== "string" || !isValidImageRef(ref)) throw new InvalidOpsInputError("Name an image by its id or as repository:tag.");
    // No -f: an image a container still uses is refused, not untagged.
    const args = ["image", "rm", ref];
    return {
        display: engineCommand(target, args),
        meta: { kind: "image", action: "remove", target: ref },
        run: (lease, signal) => runEngine(lease, target, args, { timeoutMs: REMOVE_TIMEOUT_MS, signal })
    };
}
