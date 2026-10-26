// The lists of the Kubernetes tab that grow with the cluster (pods, events)
// are printed by kubectl with a Go template that keeps only the fields the
// rows are made of, instead of whole objects: a pod takes about 1 KB that
// way instead of 10–20 KB of `-o json`, so a namespace of thousands of pods
// still fits the output cap (and the list can be cut to K8S_MAX_PODS), and
// an auto-refresh over SSH moves a fraction of the data. The output is a
// JSON document of the same shape as `-o json` (a subset of each object), so
// server/k8s/parse.ts reads either.
//
// Strings go through the template's `js` escaping, which is JSON but for
// one escape (\' for a single quote) that decodeTemplateJson() undoes. Only
// text/template features of every kubectl release are used (define and
// template, range, if/else, js), and no "%" or "!": a kubectl that is a
// Windows batch wrapper gets its arguments through cmd.exe, which cannot
// carry those (server/local/process.ts).

const DEFINITIONS = [
    // A string, or null when missing or empty.
    `{{define "s"}}{{if .}}"{{js .}}"{{else}}null{{end}}{{end}}`,
    // A number of a pod (missing: 0).
    `{{define "n"}}{{if .}}{{.}}{{else}}0{{end}}{{end}}`,
    // A number of an event (missing or 0: null, so the next field counts).
    `{{define "nn"}}{{if .}}{{.}}{{else}}null{{end}}{{end}}`,
    // A boolean (missing: false).
    `{{define "b"}}{{if .}}true{{else}}false{{end}}{{end}}`,
    // A container state: running, waiting or terminated (or none). The
    // opening brace is printed by an action: "{{{" would open one.
    `{{define "state"}}{{"{"}}` +
        `{{if .running}}"running":{"startedAt":{{template "s" .running.startedAt}}}` +
        `{{else if .waiting}}"waiting":{"reason":{{template "s" .waiting.reason}}}` +
        `{{else if .terminated}}"terminated":{"reason":{{template "s" .terminated.reason}},"exitCode":{{template "n" .terminated.exitCode}},"signal":{{template "n" .terminated.signal}},"finishedAt":{{template "s" .terminated.finishedAt}}}` +
        `{{end}}}{{end}}`,
    // A container status.
    `{{define "cs"}}{"name":{{template "s" .name}},"ready":{{template "b" .ready}},"started":{{template "b" .started}},"restartCount":{{template "n" .restartCount}},"state":{{template "state" .state}},"lastState":{{template "state" .lastState}}}{{end}}`
].join("");

// `"key":[ each item, comma separated ]` over a list field.
const each = (key: string, field: string, item: string) =>
    `"${key}":[{{range $j, $x := ${field}}}{{if $j}},{{end}}${item}{{end}}]`;

// Labels: a map has no index to tell the first entry, so every entry is
// prefixed with a comma after a `"":null` entry (no label has an empty key;
// parse.ts keeps string values only).
const LABELS = `"labels":{"":null{{range $k, $v := .metadata.labels}},"{{js $k}}":"{{js $v}}"{{end}}}`;

const POD = "{" + [
    `"metadata":{"name":{{template "s" .metadata.name}},"namespace":{{template "s" .metadata.namespace}},"creationTimestamp":{{template "s" .metadata.creationTimestamp}},"deletionTimestamp":{{template "s" .metadata.deletionTimestamp}},${LABELS},` +
        each("ownerReferences", ".metadata.ownerReferences", `{"kind":{{template "s" .kind}},"name":{{template "s" .name}},"controller":{{template "b" .controller}}}`) + "}",
    `"spec":{"nodeName":{{template "s" .spec.nodeName}},` +
        each("containers", ".spec.containers", `{"name":{{template "s" .name}}}`) + "," +
        each("initContainers", ".spec.initContainers", `{"name":{{template "s" .name}},"restartPolicy":{{template "s" .restartPolicy}}}`) + "}",
    `"status":{"phase":{{template "s" .status.phase}},"reason":{{template "s" .status.reason}},"podIP":{{template "s" .status.podIP}},` +
        each("conditions", ".status.conditions", `{"type":{{template "s" .type}},"status":{{template "s" .status}}}`) + "," +
        each("containerStatuses", ".status.containerStatuses", `{{template "cs" .}}`) + "," +
        each("initContainerStatuses", ".status.initContainerStatuses", `{{template "cs" .}}`) + "}"
].join(",") + "}";

const EVENT = "{" + [
    `"type":{{template "s" .type}},"reason":{{template "s" .reason}},"note":{{template "s" .note}},"message":{{template "s" .message}}`,
    `"metadata":{"namespace":{{template "s" .metadata.namespace}},"creationTimestamp":{{template "s" .metadata.creationTimestamp}}}`,
    `"involvedObject":{"kind":{{template "s" .involvedObject.kind}},"name":{{template "s" .involvedObject.name}},"namespace":{{template "s" .involvedObject.namespace}}}`,
    `"series":{"count":{{template "nn" .series.count}},"lastObservedTime":{{template "s" .series.lastObservedTime}}}`,
    `"count":{{template "nn" .count}},"firstTimestamp":{{template "s" .firstTimestamp}},"lastTimestamp":{{template "s" .lastTimestamp}},"eventTime":{{template "s" .eventTime}}`,
    `"reportingComponent":{{template "s" .reportingComponent}},"source":{"component":{{template "s" .source.component}}}`
].join(",") + "}";

const list = (item: string) => `${DEFINITIONS}{"items":[{{range $i, $o := .items}}{{if $i}},{{end}}${item}{{end}}]}`;

export const POD_LIST_TEMPLATE = list(POD);
export const EVENT_LIST_TEMPLATE = list(EVENT);

export const goTemplateArgs = (template: string) => ["-o", `go-template=${template}`];

// The template's `js` escapes as JSON: only \' is not one. A backslash pair
// (`\\`) is consumed as a whole, so what follows it is never read as an escape.
export function jsEscapedToJson(text: string): string {
    return text.replace(/\\([\s\S])/g, (match, escaped: string) => (escaped === "'" ? "'" : match));
}

// The document a list template printed (null: not one). Like extractJson()
// of server/ops/remote.ts, what comes before or after it is left out.
export function decodeTemplateJson(output: string): unknown {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start === -1 || end < start) return null;
    try {
        return JSON.parse(jsEscapedToJson(output.slice(start, end + 1)));
    } catch {
        return null;
    }
}
