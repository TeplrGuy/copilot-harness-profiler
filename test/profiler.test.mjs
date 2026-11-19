import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkRecord, otelRecords, project, parseLine } from "../.github/extensions/copilot-harness-profiler/normalize.mjs";
import { Store } from "../.github/extensions/copilot-harness-profiler/store.mjs";
import { startServer } from "../.github/extensions/copilot-harness-profiler/server.mjs";

const event = (type, data = {}, extra = {}) => ({ id: `${type}-${JSON.stringify(data)}`, type, data, timestamp: "2026-11-19T15:00:00Z", ...extra });
const span = (id = "tool", extra = {}) => ({
    spanId: id, traceId: "trace", name: "execute_tool view",
    startTime: [1000, 0], endTime: [1000, 500000000],
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "view", "gen_ai.conversation.id": "session" },
    ...extra,
});
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "copilot-profiler-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, store: new Store(join(root, "store")) };
}
test("SDK capture strips arguments/results and full skill content by default", () => {
    const a = sdkRecord(event("tool.execution_start", { toolCallId: "call", toolName: "view", arguments: { secret: "hidden" } }), "s");
    const b = sdkRecord(event("skill.invoked", { name: "review", content: "confidential" }), "s");
    assert.equal(a.content, undefined);
    assert.equal(b.content, undefined);
    assert.equal(b.name, "review");
});
test("SDK pairs parallel calls by call and context identity, not time", () => {
    const records = [
        sdkRecord(event("tool.execution_start", { toolCallId: "same", toolName: "first" }, { agentId: "a" }), "s"),
        sdkRecord(event("tool.execution_start", { toolCallId: "same", toolName: "second" }, { agentId: "b" }), "s"),
        sdkRecord(event("tool.execution_complete", { toolCallId: "same", success: false }, { agentId: "b", timestamp: "2026-11-19T15:00:02Z" }), "s"),
        sdkRecord(event("tool.execution_complete", { toolCallId: "same", success: true }, { agentId: "a", timestamp: "2026-11-19T15:00:03Z" }), "s"),
    ];
    const p = project(records);
    assert.equal(p.toolCalls, 2);
    assert.equal(p.failures, 1);
    assert.equal(p.nodes.find(n => n.name === "first").duration, 3000);
    assert.equal(p.nodes.find(n => n.name === "second").duration, 2000);
    assert.equal(p.duration, 3000);
});
test("deduplicates replayed IDs and accounting receipts; missing usage is not zero", () => {
    const record = sdkRecord(event("assistant.usage", { model: "model", inputTokens: 10, outputTokens: 2, duration: 250, accounting: { sequence: 1 } }), "s");
    const p = project([record, record, { ...record, id: "another-delivery" }, sdkRecord(event("assistant.usage", { model: "other" }), "s")]);
    assert.deepEqual(p.totals, { input: 10, output: 2 });
    assert.equal(p.modelCalls, 2);
    assert.equal(p.nodes[0].at, "2026-11-19T14:59:59.750Z");
    assert.equal(p.totals.cacheRead, undefined);
});
test("incomplete tool calls remain incomplete rather than successful zero-duration work", () => {
    const p = project([sdkRecord(event("tool.execution_start", { toolCallId: "x", toolName: "task" }), "s")]);
    assert.equal(p.incomplete, 1);
    assert.equal(p.nodes[0].duration, undefined);
    assert.equal(project([sdkRecord(event("session.start"), "s")]).incomplete, 0);
});
test("OTel nested OTLP envelopes support nanoseconds and numeric integer attributes", () => {
    const records = otelRecords({ resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "copilot-chat" } }] },
        scopeSpans: [{ spans: [{
            spanId: "a", traceId: "b", startTimeUnixNano: "1000000000", endTimeUnixNano: "1500000000",
            attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } }],
        }] }],
    }] }, "otel");
    assert.equal(records[0].duration, 500);
    assert.equal(records[0].usage.input, 42);
    assert.equal(records[0].service, "copilot-chat");
});
test("aggregate wrapper and root usage do not double count leaf usage or AI units", () => {
    const records = otelRecords([
        span("root", { name: "invoke_agent", attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.usage.input_tokens": 900, "github.copilot.nano_aiu": 7 } }),
        span("chat", { name: "chat", parentSpanId: "root", attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 900, "github.copilot.nano_aiu": 7 } }),
        span("sub", { name: "invoke_agent", parentSpanId: "root", attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.usage.input_tokens": 900, "github.copilot.nano_aiu": 7 } }),
    ], "otel");
    const p = project(records);
    assert.equal(p.totals.input, 900);
    assert.equal(p.nanoAiu, 7);
});
test("VS Code legacy cache-creation counters and skill markers normalize without content", () => {
    const r = otelRecords(span("s", {
        attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.cache_creation.input_tokens": 25, "gen_ai.input.messages": "SECRET" },
        events: [{ name: "github.copilot.skill.invoked", time: [1000, 0], attributes: { "github.copilot.skill.name": "testing" } }],
    }), "vscode");
    assert.equal(r[0].usage.cacheWrite, 25);
    assert.equal(r[0].content, undefined);
    assert.equal(r[1].kind, "skill");
    assert.equal(r[1].name, "testing");
});
test("Harness Profiler import remains source-labeled and does not invent token spend", () => {
    const [r] = parseLine(JSON.stringify({ v: 2, session: "claude", at: "2026-11-19T15:00:00Z", tool: "Skill", name: "planner", args: "SECRET", tokens: 10 }), "harness", "harness:import");
    assert.equal(r.kind, "skill"); assert.equal(r.usage, undefined); assert.equal(r.content, undefined);
    assert.throws(() => parseLine('{"v":99}', "harness", "x"), /v2/);
});
test("content requires warned opt-in and masking precedes persistence", t => {
    const { store } = fixture(t);
    assert.throws(() => store.configure({ content: true }), /confirmation/);
    store.configure({ content: true, confirm: "I understand content may contain secrets" });
    store.capture(event("tool.execution_start", { toolName: "view", toolCallId: "x", arguments: { token: "secret123" } }), "s");
    const raw = readFileSync(join(store.data, readdirSync(store.data)[0]), "utf8");
    assert.ok(!raw.includes("secret123"));
    assert.ok(raw.includes("REDACTED"));
    store.configure({ content: false });
    assert.throws(() => store.exportTrace(store.sessions()[0].key, true), /warning/);
});
test("store survives new instances and panel identities; rejects path traversal", t => {
    const { store } = fixture(t);
    store.capture(event("skill.invoked", { name: "test" }), "session");
    const fresh = new Store(store.home), key = fresh.sessions()[0].key;
    assert.equal(fresh.trace(key).nodes[0].name, "test");
    fresh.capture(event("skill.invoked", { name: "test" }), "session");
    assert.equal(fresh.trace(key).nodes.length, 1);
    assert.throws(() => fresh.trace("..\\settings"), /Invalid/);
});
test("import preview is bounded, content-free by default, and detects changed files", t => {
    const { root, store } = fixture(t), path = join(root, "input.jsonl");
    writeFileSync(path, `${JSON.stringify(span())}\n`);
    const preview = store.previewImport({ path, format: "otel" });
    assert.equal(preview.records.length, 1);
    appendFileSync(path, "\n");
    assert.throws(() => store.applyImport({ path, format: "otel", digest: preview.digest }), /changed/);
    writeFileSync(path, "broken\n");
    assert.throws(() => store.previewImport({ path, format: "otel" }), /Line 1/);
});
test("file following handles partial lines, append, repeated refresh, and truncation", t => {
    const { root, store } = fixture(t), path = join(root, "follow.jsonl");
    writeFileSync(path, `${JSON.stringify(span("one"))}\n`);
    const p = store.previewImport({ path, format: "otel" });
    store.register({ path, format: "otel", digest: p.digest });
    store.refresh(); store.refresh();
    assert.equal(store.sessions()[0].toolCalls, 1);
    const second = JSON.stringify(span("two"));
    appendFileSync(path, second.slice(0, 30)); store.refresh();
    assert.equal(store.errors.length, 0);
    appendFileSync(path, `${second.slice(30)}\n`); store.refresh();
    assert.equal(store.sessions()[0].toolCalls, 2);
    writeFileSync(path, `${JSON.stringify(span("x"))}\n`); store.refresh();
    assert.equal(store.sessions()[0].toolCalls, 3);
});
test("pause stops new capture and export removes source paths; deleting retains originals", async t => {
    const { root, store } = fixture(t), path = join(root, "original.jsonl");
    writeFileSync(path, `${JSON.stringify(span())}\n`);
    const p = store.previewImport({ path, format: "otel", label: "private-name" });
    store.applyImport({ path, format: "otel", label: "private-name", digest: p.digest });
    store.configure({ paused: true });
    store.capture(event("skill.invoked", { name: "should-not-appear" }), "s");
    assert.equal(store.sessions().length, 1);
    const key = store.sessions()[0].key, exported = store.exportTrace(key);
    assert.ok(!JSON.stringify(exported).includes("private-name"));
    await store.deleteTrace(key, key);
    assert.equal(readFileSync(path, "utf8").length > 0, true);
    assert.equal(store.sessions().length, 0);
});
test("HTTP canvas requires capability and rejects foreign origins and hosts", async t => {
    const { store } = fixture(t), server = await startServer(store);
    t.after(() => server.close());
    const token = new URL(server.url).hash.slice(1);
    assert.equal((await fetch(`${server.origin}/api/state`)).status, 403);
    assert.equal((await fetch(`${server.origin}/api/state`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } })).status, 403);
    const state = await fetch(`${server.origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).version, "0.1.0");
    const html = await fetch(server.origin);
    assert.ok(html.headers.get("content-security-policy").includes("script-src 'self'"));
    const invalid = await fetch(`${server.origin}/api/action`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "import", input: { id: "unknown" } }) });
    assert.equal(invalid.status, 400);
});
test("HTTP preview/import path preserves consent and frozen file revision", async t => {
    const { root, store } = fixture(t), server = await startServer(store), path = join(root, "span.jsonl");
    t.after(() => server.close());
    writeFileSync(path, `${JSON.stringify(span())}\n`);
    const headers = { Authorization: `Bearer ${new URL(server.url).hash.slice(1)}`, "Content-Type": "application/json" };
    const post = async (action, input) => {
        const res = await fetch(`${server.origin}/api/action`, { method: "POST", headers, body: JSON.stringify({ action, input }) });
        return { status: res.status, data: await res.json() };
    };
    assert.equal((await post("preview", { path, format: "otel", content: true })).status, 400);
    const preview = await post("preview", { path, format: "otel", surface: "cli" });
    assert.equal(preview.data.records, 1);
    assert.equal((await post("import", { id: preview.data.id })).status, 200);
    assert.equal((await post("import", { id: preview.data.id })).status, 400);
    assert.equal(store.sessions()[0].surface, "cli");
});
