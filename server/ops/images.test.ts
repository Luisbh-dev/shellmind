import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ImageInfo } from '../../shared/ops';
import { testCaps } from '../../test/helpers/opsCaps';
import { requireEngine } from './containers';
import {
    estimatePrune,
    imageListScript,
    parseDiskUsageRows,
    parseImageList,
    parsePruneOutput,
    parseSize,
    parseUniqueSizes,
    prepareImageRemoval,
    preparePrune,
    pruneCandidates,
} from './images';

// W7-S3: images, disk usage and prunes (outputs as Docker 29 and Podman print them).

const ID = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const DOCKER_IMAGES = [
    { Containers: '1', CreatedAt: '2026-09-17 20:37:20 +0000 UTC', CreatedSince: '5 weeks ago', ID: ID(1), Repository: 'alpine', Size: '8.42MB', Tag: '3' },
    { Containers: '0', CreatedAt: '2026-10-24 15:18:41 +0000 UTC', CreatedSince: '1 second ago', ID: ID(2), Repository: 'demo-app', Size: '4.42MB', Tag: 'latest' },
    { Containers: 'N/A', CreatedAt: '2026-10-24 15:18:40 +0000 UTC', CreatedSince: '2 seconds ago', ID: ID(3), Repository: '<none>', Size: '4.42MB', Tag: '<none>' },
    // An intermediate layer of the classic builder (untagged, not dangling, unused).
    { Containers: 'N/A', CreatedAt: '2026-10-24 15:18:00 +0000 UTC', CreatedSince: '1 minute ago', ID: ID(4), Repository: '<none>', Size: '4.42MB', Tag: '<none>' },
    // A second tag of the alpine image.
    { Containers: '1', CreatedAt: '2026-09-17 20:37:20 +0000 UTC', CreatedSince: '5 weeks ago', ID: ID(1), Repository: 'registry.local/alpine', Size: '8.42MB', Tag: '3' },
].map((item) => JSON.stringify(item)).join('\n');

const sections = (values: Record<string, string>) => `${Object.entries(values).map(([name, body]) => `\n@@SM:${name}\n${body}`).join('')}\n@@SM:end\n`;

const docker = requireEngine(testCaps());

function images(): ImageInfo[] {
    const output = sections({ images: DOCKER_IMAGES, rc: '0', dangling: ID(3), used: `${ID(1)}\n${ID(1)}` });
    return parseImageList(docker, output).list.images;
}

describe('sizes', () => {
    it('reads the engines\' sizes as bytes', () => {
        expect(parseSize('8.42MB')).toBe(8_420_000);
        expect(parseSize('16.1kB')).toBe(16_100);
        expect(parseSize('8B')).toBe(8);
        expect(parseSize('1.2GB (45%)')).toBe(1_200_000_000);
        expect(parseSize('27.5MiB')).toBe(28_835_840);
        expect(parseSize(1234)).toBe(1234);
        expect(parseSize('N/A')).toBeNull();
        expect(parseSize(undefined)).toBeNull();
    });
});

describe('image list', () => {
    it('flags dangling and used images and leaves the builder\'s intermediate layers out', () => {
        const list = images();
        expect(list.map((image) => [image.reference, image.containers, image.dangling])).toEqual([
            [null, 0, true],
            ['alpine:3', 2, false],
            ['demo-app:latest', 0, false],
            ['registry.local/alpine:3', 2, false],
        ]);
        expect(list[1]).toEqual({
            id: ID(1), repository: 'alpine', tag: '3', reference: 'alpine:3', size: 8_420_000,
            createdAt: '2026-09-17 20:37:20 +0000 UTC', createdSince: '5 weeks ago', containers: 2, dangling: false,
        });
    });

    it('does not call an untagged image a container still uses dangling', () => {
        const output = sections({ images: DOCKER_IMAGES, rc: '0', dangling: ID(3), used: ID(3) });
        expect(parseImageList(docker, output).list.images.find((image) => image.id === ID(3))).toMatchObject({ dangling: false, containers: 1 });
    });

    it('reads Podman 5\'s list: one entry per name, each with all the names', () => {
        const podman = requireEngine(testCaps({ containers: { engine: 'podman', compose: false } }));
        // `podman image ls -a --format json` (Podman 5.8.9): alpine has three
        // names, so three identical entries; the dangling image has none.
        const raw = readFileSync(new URL('../../test/fixtures/ops/podman-images.json', import.meta.url), 'utf8');
        const alpine = 'sha256:320994c3b997e2ec6433f717f153e108023c5bec8fefa8d76b83451d16d05ea8';
        const dangling = 'sha256:a00059468f1ff31cb6e886950c88b1d95f44a30fa614795643e3fa65e922e11e';
        const { list } = parseImageList(podman, sections({ images: raw, rc: '0', dangling, used: alpine }));
        expect(list.images.map((image) => [image.reference, image.size, image.containers, image.dangling])).toEqual([
            [null, 8_709_993, 0, true],
            ['docker.io/library/alpine:3', 8_715_873, 1, false],
            ['docker.io/library/alpine:latest', 8_715_873, 1, false],
            ['localhost/demo-app:latest', 8_711_017, 0, false],
            ['localhost/mine:1', 8_715_873, 1, false],
        ]);
        expect(new Set(list.images.map((image) => `${image.id} ${image.reference}`)).size).toBe(list.images.length);
        expect(list.images[1]).toMatchObject({ id: alpine, repository: 'docker.io/library/alpine', tag: '3', createdAt: '2026-09-17T20:37:20.000Z' });
        expect(pruneCandidates(list.images, 'unused').map((image) => image.reference)).toEqual([null, 'localhost/demo-app:latest']);
    });

    it('asks the engine for every image, the dangling ones and what containers use', () => {
        const script = imageListScript(requireEngine(testCaps({ containers: { sudo: true } })));
        expect(script).toContain("sudo -n docker 'image' 'ls' '-a' '--no-trunc' '--format' '{{json .}}' 2>&1");
        expect(script).toContain("sudo -n docker 'image' 'ls' '-q' '--no-trunc' '--filter' 'dangling=true'");
        expect(script).toContain("sudo -n docker 'ps' '-aq' '--no-trunc' 2>/dev/null | xargs -r sudo -n docker 'inspect' '--format' '{{.Image}}'");
    });
});

describe('disk usage', () => {
    it('reads Docker\'s and Podman\'s `system df`', () => {
        const dockerRows = parseDiskUsageRows([
            '{"Active":"2","Reclaimable":"0B (0%)","Size":"12.83MB","TotalCount":"2","Type":"Images"}',
            '{"Active":"2","Reclaimable":"0B","Size":"0B","TotalCount":"2","Type":"Containers"}',
            '{"Active":"1","Reclaimable":"80.72MB (19%)","Size":"414.7MB","TotalCount":"6","Type":"Local Volumes"}',
            '{"Active":"0","Reclaimable":"2.885GB","Size":"10.95GB","TotalCount":"576","Type":"Build Cache"}',
        ].join('\n'));
        expect(dockerRows).toEqual([
            { kind: 'images', count: 2, active: 2, size: 12_830_000, reclaimable: 0 },
            { kind: 'containers', count: 2, active: 2, size: 0, reclaimable: 0 },
            { kind: 'volumes', count: 6, active: 1, size: 414_700_000, reclaimable: 80_720_000 },
            { kind: 'build-cache', count: 576, active: 0, size: 10_950_000_000, reclaimable: 2_885_000_000 },
        ]);
        const podmanRows = parseDiskUsageRows('[{"Type":"Images","Total":3,"Active":1,"RawSize":1234,"RawReclaimable":12,"Size":"1.234kB","Reclaimable":"12B (1%)"}]');
        expect(podmanRows).toEqual([{ kind: 'images', count: 3, active: 1, size: 1234, reclaimable: 12 }]);
    });

    it('reads the space only each image holds from `system df -v`', () => {
        const verbose = JSON.stringify({ Images: [{ ID: ID(2), UniqueSize: '8B', SharedSize: '4.417MB' }, { ID: ID(3), UniqueSize: '4B' }, { ID: ID(1), UniqueSize: 'N/A' }], Containers: [] });
        expect(parseUniqueSizes(verbose)).toEqual({ [ID(2)]: 8, [ID(3)]: 4 });
        expect(parseUniqueSizes('docker: --format is not supported with -v')).toEqual({});
    });
});

describe('prunes', () => {
    it('previews what each prune removes (an image with several tags once)', () => {
        expect(pruneCandidates(images(), 'dangling').map((image) => image.id)).toEqual([ID(3)]);
        expect(pruneCandidates(images(), 'unused').map((image) => image.id)).toEqual([ID(3), ID(2)]);
        expect(pruneCandidates(images(), 'build-cache')).toEqual([]);
    });

    it('estimates the space freed from unique sizes, else the sum of the sizes', () => {
        const candidates = pruneCandidates(images(), 'unused');
        expect(estimatePrune('unused', candidates, { rows: [], uniqueSizes: { [ID(2)]: 8, [ID(3)]: 4 } })).toEqual({ bytes: 12, estimate: 'at-least' });
        expect(estimatePrune('unused', candidates, { rows: [], uniqueSizes: { [ID(2)]: 8 } })).toEqual({ bytes: 8_840_000, estimate: 'up-to' });
        expect(estimatePrune('build-cache', [], { rows: [{ kind: 'build-cache', count: 3, active: 0, size: 100, reclaimable: 60 }], uniqueSizes: {} })).toEqual({ bytes: 60, estimate: 'exact' });
    });

    it('builds the prune and removal commands from validated input', () => {
        expect(preparePrune(testCaps(), 'dangling')).toMatchObject({ display: "docker 'image' 'prune' '-f'", meta: { kind: 'image', action: 'prune-dangling', target: 'dangling' } });
        expect(preparePrune(testCaps(), 'unused').display).toBe("docker 'image' 'prune' '-a' '-f'");
        // Not -a: the preview's figure (`system df` reclaimable) is what it frees.
        expect(preparePrune(testCaps({ containers: { sudo: true } }), 'build-cache').display).toBe("sudo -n docker 'builder' 'prune' '-f'");
        expect(() => preparePrune(testCaps({ containers: { engine: 'podman' } }), 'build-cache')).toThrow(/needs Docker/);
        expect(() => preparePrune(testCaps(), 'everything')).toThrow(expect.objectContaining({ code: 'OPS_INVALID_INPUT' }));
        expect(() => preparePrune(testCaps({ platform: 'windows' }), 'dangling')).toThrow(expect.objectContaining({ code: 'OPS_UNSUPPORTED' }));

        expect(prepareImageRemoval(testCaps(), 'registry.example.com:5000/shop/api:1.4.0')).toMatchObject({
            display: "docker 'image' 'rm' 'registry.example.com:5000/shop/api:1.4.0'",
            meta: { kind: 'image', action: 'remove', target: 'registry.example.com:5000/shop/api:1.4.0' },
        });
        expect(prepareImageRemoval(testCaps(), ID(3)).display).toBe(`docker 'image' 'rm' '${ID(3)}'`);
        for (const ref of ["x'; id #", '-f', '../etc', 'a//b', 'alpine 3', '', 42, '$(id)', 'a..b']) {
            expect(() => prepareImageRemoval(testCaps(), ref), String(ref)).toThrow(expect.objectContaining({ code: 'OPS_INVALID_INPUT' }));
        }
    });

    it('reads the space a prune reclaimed', () => {
        expect(parsePruneOutput('Deleted Images:\ndeleted: sha256:6bd0\ndeleted: sha256:28bd\n\nTotal reclaimed space: 4.42MB\n')).toEqual({ reclaimedBytes: 4_420_000 });
        expect(parsePruneOutput('ID\t\tRECLAIMABLE\tSIZE\nabc\ttrue\t1.2GB\nTotal:\t2.885GB\n')).toEqual({ reclaimedBytes: 2_885_000_000 });
        expect(parsePruneOutput('4f1c\n9e2a\n')).toEqual({ reclaimedBytes: null });
    });
});
