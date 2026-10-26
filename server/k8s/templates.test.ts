import { describe, expect, it } from 'vitest';
import { K8S_MAX_EVENTS, K8S_MAX_PODS } from '../../shared/k8s';
import type { KubectlResult, KubectlRunner, KubectlRunOptions } from './runner';
import { listEvents, listPods } from './service';
import { decodeTemplateJson, EVENT_LIST_TEMPLATE, jsEscapedToJson, POD_LIST_TEMPLATE } from './templates';

// W8-T2: the compact list templates (server/k8s/templates.ts). That kubectl
// prints exactly what parse.ts reads from `-o json` is checked against a
// real cluster by test/e2e/k8s-k3s.test.ts; here, how their output is read
// and what it allows.

// What a template prints for one pod (as kubectl 1.31 prints it).
const podLine = (index: number) =>
    `{"metadata":{"name":"web-${index}","namespace":"shop","creationTimestamp":"2026-10-24T10:00:00Z","deletionTimestamp":null,"labels":{"":null,"app":"web","pod-template-hash":"5c4678d445"},"ownerReferences":[{"kind":"ReplicaSet","name":"web-5c4678d445","controller":true}]},` +
    `"spec":{"nodeName":"node-1","containers":[{"name":"app"}],"initContainers":[]},` +
    `"status":{"phase":"Running","reason":null,"podIP":"10.42.0.${index % 250}","conditions":[{"type":"Ready","status":"True"}],` +
    `"containerStatuses":[{"name":"app","ready":true,"started":true,"restartCount":0,"state":{"running":{"startedAt":"2026-10-24T10:00:01Z"}},"lastState":{}}],"initContainerStatuses":[]}}`;

const eventLine = (index: number, type = 'Normal') =>
    `{"type":"${type}","reason":"Pulled","note":null,"message":"Image \\u0026 tag pulled (${index})","metadata":{"namespace":"shop","creationTimestamp":"2026-10-24T10:00:00Z"},` +
    `"involvedObject":{"kind":"Pod","name":"web-${index}","namespace":"shop"},"series":{"count":null,"lastObservedTime":null},"count":2,` +
    `"firstTimestamp":"2026-10-24T10:00:00Z","lastTimestamp":"2026-10-24T10:${String(index % 60).padStart(2, '0')}:00Z","eventTime":null,"reportingComponent":null,"source":{"component":"kubelet"}}`;

function fakeRunner(stdout: string): KubectlRunner & { calls: string[][] } {
    const calls: string[][] = [];
    return {
        kind: 'ssh',
        serverId: 1,
        calls,
        display: (args) => args.join(' '),
        run: async (args: readonly string[], _options: KubectlRunOptions): Promise<KubectlResult> => {
            calls.push([...args]);
            return { stdout, stderr: '', code: 0 };
        },
        stream: async () => ({ code: 0 })
    };
}

describe('compact list templates', () => {
    it('can go through cmd.exe to a batch-file kubectl (no % or !, no line breaks)', () => {
        for (const template of [POD_LIST_TEMPLATE, EVENT_LIST_TEMPLATE]) {
            expect(template).not.toMatch(/[%!\r\n]/);
            // Never "{{{": it would open an action one brace early.
            expect(template).not.toContain('{{{');
        }
    });

    it("reads the template's js escaping as JSON", () => {
        expect(jsEscapedToJson(String.raw`"it\'s \u003Cb\u003E \"q\" back\\slash \\\' \u0007"`)).toBe(String.raw`"it's \u003Cb\u003E \"q\" back\\slash \\' \u0007"`);
        expect(JSON.parse(jsEscapedToJson(String.raw`"it\'s \u003Cb\u003E\u0026\u003D \\\' end"`))).toBe("it's <b>&= \\' end");
        // `-o json` output reads the same.
        expect(decodeTemplateJson('{"items":[{"a":"x\\\\y \\"z\\""}]}')).toEqual({ items: [{ a: 'x\\y "z"' }] });
        // What a batch wrapper may echo before it is left out; garbage is not a list.
        expect(decodeTemplateJson('C:\\> kubectl\r\n{"items":[]}\r\n')).toEqual({ items: [] });
        expect(decodeTemplateJson('error: template: output:1: function "json" not defined')).toBeNull();
        expect(decodeTemplateJson('{"items":[')).toBeNull();
    });

    it('cuts a namespace with more pods than the list shows, and the output stays small', async () => {
        const count = K8S_MAX_PODS + 500;
        const stdout = `{"items":[${Array.from({ length: count }, (_, index) => podLine(index)).join(',')}]}`;
        // About 0.7 KB a pod: thousands fit far below the 48 MB cap.
        expect(stdout.length / count).toBeLessThan(1000);
        const runner = fakeRunner(stdout);
        const list = await listPods(runner, 'prod', '*');
        expect(list.truncated).toBe(true);
        expect(list.pods).toHaveLength(K8S_MAX_PODS);
        expect(list.pods[0]).toMatchObject({ name: 'web-0', status: 'Running', ready: 1, total: 1, running: ['app'], owner: { kind: 'Deployment', name: 'web' }, labels: { app: 'web' } });
        expect(runner.calls[0]).toEqual(['--context', 'prod', '--request-timeout=20s', 'get', 'pods', '--all-namespaces', '-o', `go-template=${POD_LIST_TEMPLATE}`]);
    });

    it('keeps the warnings and the latest events of a busy cluster', async () => {
        const count = K8S_MAX_EVENTS * 4;
        const lines = Array.from({ length: count }, (_, index) => eventLine(index, index % 97 === 0 ? 'Warning' : 'Normal'));
        const events = await listEvents(fakeRunner(`{"items":[${lines.join(',')}]}`), 'prod', 'shop');
        expect(events).toHaveLength(K8S_MAX_EVENTS);
        expect(events.filter((event) => event.type === 'Warning')).toHaveLength(Math.ceil(count / 97));
        expect(events[0]).toMatchObject({ type: 'Warning', message: expect.stringContaining('Image & tag pulled'), count: 2, object: { kind: 'Pod' } });
    });

    it('says when kubectl printed something that is not a list', async () => {
        await expect(listPods(fakeRunner('<no value>'), 'prod', 'shop')).rejects.toMatchObject({ code: 'K8S_COMMAND_FAILED', status: 502 });
    });
});
