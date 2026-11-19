// Bootstrapped with the SDK's canvas scaffold. Stdout belongs to JSON-RPC.
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { Store } from "./store.mjs";
import { startServer } from "./server.mjs";

const store = new Store();
const servers = new Map();
const objectSchema = { type: "object", additionalProperties: false, properties: {} };
function action(name, description, handler, inputSchema = objectSchema) {
    return {
        name, description, inputSchema,
        handler: async ctx => {
            try { return await handler(ctx.input || {}); }
            catch (error) { throw new CanvasError("profiler_error", error.message); }
        },
    };
}
const canvas = createCanvas({
    id: "copilot-harness-profiler",
    displayName: "Copilot Harness Profiler",
    description: "Explore local Copilot execution traces, context diagrams, tools, skills, models and source coverage.",
    inputSchema: objectSchema,
    actions: [
        action("get_status", "Read capture settings, registered sources and collection errors.", () => ({ settings: store.publicSettings(), errors: store.errors })),
        action("list_sessions", "List observed sessions only, not an account-wide inventory.", () => { store.refresh(); return store.sessions().slice(0, 100); }),
        action("get_trace", "Inspect a stored execution trace by its profiler session key.", input => store.trace(input.key), {
            type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        }),
        action("refresh", "Refresh registered local sources and return session counts.", () => { store.refresh(); return { sessions: store.sessions().length, errors: store.errors }; }),
    ],
    open: async ctx => {
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer(store);
            servers.set(ctx.instanceId, entry);
        }
        return { title: "Copilot Harness Profiler", url: entry.url };
    },
    onClose: async ctx => {
        const entry = servers.get(ctx.instanceId);
        if (entry) { servers.delete(ctx.instanceId); await entry.close(); }
    },
});
let attachedId;
const early = [];
function capture(event) {
    try {
        if (attachedId) store.capture(event, attachedId);
        else if (early.length < 1000) early.push(event);
    } catch (error) { store.diagnostic(error); process.stderr.write(`Profiler: ${error.message}\n`); }
}
const session = await joinSession({ canvases: [canvas], onEvent: capture });
attachedId = session.sessionId;
for (const event of early.splice(0)) capture(event);
try {
    for (const event of await session.getEvents()) capture(event);
} catch (error) { store.diagnostic(error); await session.log(`Profiler history unavailable: ${error.message}`, { level: "warning", ephemeral: true }); }
const refresh = setInterval(() => {
    try { store.refresh(); } catch (error) { store.diagnostic(error); }
}, 5000);
refresh.unref();
