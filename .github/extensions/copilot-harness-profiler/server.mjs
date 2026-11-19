import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const assets = fileURLToPath(new URL(".", import.meta.url));
export const coverage = [
    { id: "copilot-sdk", name: "Copilot app / attached runtime", capability: "Live SDK events + session replay", status: "Connected when this extension is loaded", detail: "Tools, skills and agents from the attached session. Historical per-call usage may be missing; other sessions need their own collector." },
    { id: "cli", name: "Copilot CLI", capability: "Shared-runtime OTel JSONL", status: "Setup required", detail: "Enable the file exporter in the shell that launches the CLI, run a new session, then register its output file." },
    { id: "vscode", name: "VS Code Copilot / Agent Host", capability: "Shared-runtime OTel + wrapper spans", status: "Setup required", detail: "Exporter configuration depends on the running host and policy. Import a verified file; wrapper totals are not added to model-call totals." },
    { id: "local", name: "VS Code Local harness", capability: "VS Code OTel JSONL adapter", status: "Setup required", detail: "Uses different settings/schema from Agent Host. Configure the file exporter and start a fresh test session." },
    { id: "remote", name: "Remote / containers / cloud agent", capability: "Explicit supported JSONL imports", status: "Import only", detail: "Capture runs on that host. Transfer a retained export yourself. Local canvas installation does not instrument cloud jobs." },
    { id: "harness", name: "Harness Profiler / Claude traces", capability: "Harness Profiler v2 JSONL import", status: "Import only", detail: "Compatibility view, not Copilot capture. Claude transcript token inference is not reused." },
    { id: "other", name: "Other IDEs / web / mobile / completions", capability: "No verified universal session export", status: "Unverified", detail: "No claim of execution profiling. Aggregate usage or a visible session is not equivalent to a full trace." },
];

export async function startServer(store) {
    const token = randomBytes(32).toString("hex");
    const previews = new Map(), clients = new Set();
    let origin;
    function state() {
        store.refresh();
        return { sessions: store.sessions(), settings: store.publicSettings(), coverage, errors: store.errors, version: "0.1.0" };
    }
    const json = (res, code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
    };
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
        try {
            if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Unexpected host" });
            if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "Unexpected origin" });
            const url = new URL(req.url, origin);
            if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
                const file = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] }[url.pathname];
                res.setHeader("Content-Type", `${file[1]}; charset=utf-8`);
                return res.end(readFileSync(join(assets, file[0])));
            }
            if (req.headers.authorization !== `Bearer ${token}` && !(url.pathname === "/events" && url.searchParams.get("token") === token)) return json(res, 403, { error: "Canvas capability required" });
            if (req.method === "GET" && url.pathname === "/events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
                res.write("event: ready\ndata: {}\n\n");
                clients.add(res);
                req.on("close", () => clients.delete(res));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());
            if (req.method === "GET" && url.pathname === "/api/trace") return json(res, 200, store.trace(url.searchParams.get("key")));
            if (req.method !== "POST" || url.pathname !== "/api/action") return json(res, 404, { error: "Not found" });
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 1024 * 1024) throw new Error("Request exceeds 1 MiB");
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks).toString("utf8");
            const { action, input = {} } = JSON.parse(body);
            let result;
            switch (action) {
                case "configure": result = store.configure(input); break;
                case "preview": {
                    if (previews.size >= 20) previews.delete(previews.keys().next().value);
                    const preview = store.previewImport(input);
                    const id = randomBytes(16).toString("hex");
                    previews.set(id, { input: { ...input, digest: preview.digest }, expires: Date.now() + 300000 });
                    result = { id, records: preview.records.length, sessions: new Set(preview.records.map(r => r.sessionId)).size, ignored: preview.ignored, bytes: preview.size, content: preview.content };
                    break;
                }
                case "import": case "register": {
                    const held = previews.get(input.id);
                    if (!held || held.expires < Date.now()) throw new Error("Preview expired; preview the file again");
                    result = action === "register" ? store.register(held.input) : store.applyImport(held.input);
                    previews.delete(input.id);
                    break;
                }
                case "remove": result = store.removeSource(input.id); break;
                case "export": result = store.exportTrace(input.key, input.content === true); break;
                case "delete": result = await store.deleteTrace(input.key, input.confirm); break;
                default: throw new Error("Unknown action");
            }
            return json(res, 200, result);
        } catch (error) {
            store.diagnostic(error);
            return json(res, error.code === "ENOENT" ? 404 : 400, { error: error.message });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const interval = setInterval(() => {
        for (const client of clients) client.write("event: refresh\ndata: {}\n\n");
    }, 5000);
    interval.unref();
    return {
        url: `${origin}/#${token}`, origin,
        close: async () => {
            clearInterval(interval);
            for (const client of clients) client.end();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
