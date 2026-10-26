import { Router, type Request, type Response } from "express";
import {
    prepareCordon,
    prepareDeletePod,
    prepareRestart,
    prepareScale,
    prepareUseContext,
    performK8sAction,
    type PreparedK8sAction
} from "../../k8s/actions";
import { listEvents, listNamespaces, listNodes, listPods, listWorkloads, podDetail } from "../../k8s/service";
import { forgetK8sStatus, getK8sStatus, openKubectl, requireKnownContext, type KubectlSession } from "../../k8s/session";
import { requireContext, requireName, requireNamespace, requireNamespaceScope } from "../../k8s/validate";
import { abortOnClose, sendRemoteError } from "../remote";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";

// W8-T2 Kubernetes tab of a saved server. kubectl runs on the server (Linux
// over SSH) or, for a local server with the kubectl preset, on this machine.
// Requests name a context, a namespace and resources; server/k8s builds the
// kubectl argv from those validated names. A request the client abandons
// kills its kubectl.

const UNSUPPORTED = "Kubernetes needs an SSH connection to a Linux server, or a local kubectl connection.";

type K8sRequestContext = {
    session: KubectlSession;
    // The context the request names (one the kubeconfig has).
    context: string;
    signal: AbortSignal;
};

const query = (req: Request, name: string) => (typeof req.query[name] === "string" ? String(req.query[name]) : "");
const param = (req: Request, name: string) => String(req.params[name] ?? "");

function handle(context: string, work: (ctx: K8sRequestContext, req: Request) => Promise<unknown>, contextFrom: "query" | "body" = "query") {
    return async (req: Request, res: Response) => {
        const id = routeId(req.params.id);
        if (id === null) {
            sendError(res, serverNotFound(), context);
            return;
        }
        const request = abortOnClose(res);
        let session: KubectlSession | null = null;
        try {
            const name = requireContext(contextFrom === "query" ? query(req, "context") : jsonBody(req).context);
            session = await openKubectl(id, { signal: request.signal });
            requireKnownContext(session.status, name);
            res.json(await work({ session, context: name, signal: request.signal }, req));
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, context, UNSUPPORTED);
        } finally {
            session?.release();
            request.dispose();
        }
    };
}

// A POST that changes the cluster: built from the request, run, audited.
function action(context: string, prepare: (ctx: K8sRequestContext, req: Request) => PreparedK8sAction) {
    return handle(context, (ctx, req) => performK8sAction(ctx.session.runner, prepare(ctx, req), ctx.signal), "body");
}

const bodyNamespace = (req: Request) => requireNamespace(jsonBody(req).namespace);

export function createK8sRouter(): Router {
    const router = Router();

    // Whether kubectl is there and which contexts it has (never fails for a
    // missing kubectl or kubeconfig: the status says what is missing).
    router.get("/api/servers/:id/k8s/status", async (req, res) => {
        const id = routeId(req.params.id);
        if (id === null) {
            sendError(res, serverNotFound(), "GET k8s/status");
            return;
        }
        const request = abortOnClose(res);
        try {
            res.json(await getK8sStatus(id, { refresh: req.query.refresh === "1", signal: request.signal }));
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, "GET k8s/status", UNSUPPORTED);
        } finally {
            request.dispose();
        }
    });

    router.get("/api/servers/:id/k8s/namespaces", handle("GET k8s/namespaces", async ({ session, context, signal }) => ({
        namespaces: await listNamespaces(session.runner, context, { signal })
    })));

    router.get("/api/servers/:id/k8s/workloads", handle("GET k8s/workloads", ({ session, context, signal }, req) =>
        listWorkloads(session.runner, context, requireNamespaceScope(query(req, "namespace")), { signal })
    ));

    router.get("/api/servers/:id/k8s/pods", handle("GET k8s/pods", ({ session, context, signal }, req) =>
        listPods(session.runner, context, requireNamespaceScope(query(req, "namespace")), { signal })
    ));

    router.get("/api/servers/:id/k8s/events", handle("GET k8s/events", async ({ session, context, signal }, req) => ({
        events: await listEvents(session.runner, context, requireNamespaceScope(query(req, "namespace")), { signal })
    })));

    router.get("/api/servers/:id/k8s/nodes", handle("GET k8s/nodes", async ({ session, context, signal }) => ({
        nodes: await listNodes(session.runner, context, { signal })
    })));

    router.get("/api/servers/:id/k8s/pods/:pod", handle("GET k8s/pods/:pod", ({ session, context, signal }, req) =>
        podDetail(session.runner, context, requireNamespace(query(req, "namespace")), requireName(param(req, "pod"), "pod"), { signal })
    ));

    // Body { context, namespace } (+ replicas for scale).
    router.post("/api/servers/:id/k8s/workloads/:kind/:name/restart", action("POST k8s/workloads/restart", ({ context }, req) =>
        prepareRestart(context, bodyNamespace(req), param(req, "kind"), requireName(param(req, "name"), "workload"))
    ));

    router.post("/api/servers/:id/k8s/workloads/:kind/:name/scale", action("POST k8s/workloads/scale", ({ context }, req) =>
        prepareScale(context, bodyNamespace(req), param(req, "kind"), requireName(param(req, "name"), "workload"), jsonBody(req).replicas)
    ));

    router.post("/api/servers/:id/k8s/pods/:pod/delete", action("POST k8s/pods/delete", ({ context }, req) =>
        prepareDeletePod(context, bodyNamespace(req), requireName(param(req, "pod"), "pod"))
    ));

    // :action cordon | uncordon; body { context }.
    router.post("/api/servers/:id/k8s/nodes/:node/:action", action("POST k8s/nodes/:action", ({ context }, req) =>
        prepareCordon(context, requireName(param(req, "node"), "node"), param(req, "action"))
    ));

    // Makes the context kubectl's own default (the tab never does otherwise).
    router.post("/api/servers/:id/k8s/use-context", handle("POST k8s/use-context", async ({ session, context, signal }) => {
        const result = await performK8sAction(session.runner, prepareUseContext(context), signal);
        forgetK8sStatus(session.runner.serverId);
        return result;
    }, "body"));

    return router;
}
