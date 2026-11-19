import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(String(value)).digest("hex");
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = value => typeof value === "string" ? value.slice(0, 256) : undefined;
const clean = value => JSON.parse(JSON.stringify(value));
const iso = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid event timestamp");
    return date.toISOString();
};
export function redact(value) {
    return String(value)
        .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi, "[REDACTED]")
        .replace(/((?:password|secret|api[_-]?key|token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]");
}
function content(value, enabled) {
    return enabled && value !== undefined ? redact(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 8192) : undefined;
}
function usage(data, keys = {}) {
    const out = {};
    for (const [field, key] of Object.entries({
        input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadTokens",
        cacheWrite: "cacheWriteTokens", reasoning: "reasoningTokens", ...keys,
    })) {
        const n = number(data[key]);
        if (n !== undefined) out[field] = n;
    }
    return Object.keys(out).length ? out : undefined;
}

export function sdkRecord(event, sessionId, allowContent = false) {
    const d = event.data || {};
    const base = {
        v: 1, source: "copilot-sdk", surface: "copilot-sdk", sessionId, id: event.id ? hash(event.id) : undefined,
        at: iso(event.timestamp), context: text(event.agentId) || "main",
    };
    if (!base.id || !sessionId) throw new Error("SDK event is missing its identity");
    let record;
    switch (event.type) {
        case "session.start": case "session.resume":
            record = { kind: "session", phase: "start", name: "Copilot runtime", model: text(d.selectedModel) }; break;
        case "session.shutdown":
            record = { kind: "session", phase: "end", name: "Session ended" }; break;
        case "tool.execution_start":
            record = { kind: "tool", phase: "start", callId: text(d.toolCallId), parentCallId: text(d.parentToolCallId), name: text(d.toolName), model: text(d.model), content: content(d.arguments, allowContent) }; break;
        case "tool.execution_complete":
            record = { kind: "tool", phase: "end", callId: text(d.toolCallId), parentCallId: text(d.parentToolCallId), status: d.success ? "success" : "failed", content: content(d.result ?? d.error, allowContent) }; break;
        case "skill.invoked":
            record = { kind: "skill", name: text(d.name), model: text(d.model), content: content(d.arguments, allowContent) }; break;
        case "subagent.started":
            record = { kind: "agent", phase: "start", callId: text(d.toolCallId), parentContext: text(d.parentId) || "main", name: text(d.agentName), model: text(d.model) }; break;
        case "subagent.completed": case "subagent.failed":
            record = { kind: "agent", phase: "end", callId: text(d.toolCallId), name: text(d.agentName), status: event.type.endsWith("failed") ? "failed" : "success" }; break;
        case "assistant.usage":
            base.at = iso(Date.parse(base.at) - (number(d.duration) || 0));
            record = { kind: "model", name: text(d.model), model: text(d.model), duration: number(d.duration), usage: usage(d), accountingId: d.accounting ? hash(JSON.stringify(d.accounting)) : undefined }; break;
        case "session.compaction_start": case "session.compaction_complete":
            record = { kind: "compaction", phase: event.type.endsWith("start") ? "start" : "end", name: "Context compaction" }; break;
        default: return null;
    }
    return clean({ ...base, ...record });
}

function attributes(input) {
    if (!Array.isArray(input)) return input || {};
    return Object.fromEntries(input.map(a => [a.key, a.value?.stringValue ?? (a.value?.intValue !== undefined ? Number(a.value.intValue) : undefined) ?? a.value?.doubleValue ?? a.value?.boolValue]));
}
function time(value) {
    if (Array.isArray(value)) return value[0] * 1000 + value[1] / 1e6;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(BigInt(value) / 1000000n);
    return typeof value === "number" && value > 1e15 ? value / 1e6 : value;
}
export function otelRecords(input, source, allowContent = false) {
    if (Array.isArray(input)) return input.flatMap(item => otelRecords(item, source, allowContent));
    if (input.resourceSpans) return input.resourceSpans.flatMap(r =>
        (r.scopeSpans || r.instrumentationLibrarySpans || []).flatMap(s =>
            (s.spans || []).flatMap(span => otelRecords({ ...span, resource: r.resource }, source, allowContent))));
    if (input.spans) return input.spans.flatMap(span => otelRecords({ ...span, resource: input.resource }, source, allowContent));
    // Exporters can wrap a span; metrics and logs are not span-level accounting.
    if (input.span) return otelRecords(input.span, source, allowContent);
    const a = attributes(input.attributes);
    const spanId = input.spanId || input.spanContext?.spanId;
    const traceId = input.traceId || input.spanContext?.traceId;
    if (!spanId || !traceId) return [];
    const operation = a["gen_ai.operation.name"] || String(input.name || "").split(" ")[0];
    const kind = { invoke_agent: "agent", chat: "model", execute_tool: "tool", execute_hook: "hook", plan: "plan" }[operation] || "span";
    const start = time(input.startTimeUnixNano ?? input.startTime);
    const end = time(input.endTimeUnixNano ?? input.endTime);
    const reported = usage(a, {
        input: "gen_ai.usage.input_tokens", output: "gen_ai.usage.output_tokens",
        cacheRead: "gen_ai.usage.cache_read.input_tokens",
        cacheWrite: a["gen_ai.usage.cache_write.input_tokens"] !== undefined ? "gen_ai.usage.cache_write.input_tokens" : "gen_ai.usage.cache_creation.input_tokens",
        reasoning: "gen_ai.usage.reasoning.output_tokens",
    });
    const context = attributes(input.resource?.attributes);
    const root = !input.parentSpanId && !input.parent_span_id;
    const base = clean({
        v: 1, source, sessionId: text(a["gen_ai.conversation.id"]) || `trace-${traceId}`,
        id: `${traceId}:${spanId}`, spanId, traceId, parentSpanId: input.parentSpanId || input.parent_span_id,
        at: iso(start), duration: Number.isFinite(end) && end >= start ? end - start : undefined,
        kind, phase: "complete", name: text(a["gen_ai.tool.name"] || a["gen_ai.agent.name"] || input.name),
        callId: text(a["gen_ai.tool.call.id"]), context: text(a["gen_ai.agent.id"]),
        model: text(a["gen_ai.response.model"] || a["gen_ai.request.model"]),
        service: text(context["service.name"]), version: text(context["service.version"]),
        status: a["error.type"] || input.status?.code === 2 || input.status?.code === "STATUS_CODE_ERROR" ? "failed" : "success",
        usage: reported, usageRole: kind === "model" ? "leaf" : "aggregate",
        nanoAiu: root && kind === "agent" ? number(a["github.copilot.nano_aiu"]) : undefined,
        content: content({
            arguments: a["gen_ai.tool.call.arguments"], result: a["gen_ai.tool.call.result"],
            input: a["gen_ai.input.messages"], output: a["gen_ai.output.messages"],
        }, allowContent),
    });
    if (base.content === "{}") delete base.content;
    const markers = (input.events || []).filter(e => /skill.invoked|compaction/.test(e.name)).map((e, index) => {
        const ea = attributes(e.attributes);
        return clean({
            v: 1, source, sessionId: base.sessionId, id: `${base.id}:event:${index}`,
            at: iso(time(e.timeUnixNano ?? e.time) ?? start),
            kind: e.name.includes("skill") ? "skill" : "compaction", name: text(ea["github.copilot.skill.name"] || e.name),
            parentSpanId: spanId, traceId,
        });
    });
    return [base, ...markers];
}

export function harnessRecord(record, source, allowContent = false) {
    if (record.v !== 2 || !record.session || !record.at) throw new Error("Expected a Harness Profiler v2 record");
    return clean({
        v: 1, source, sessionId: text(record.session),
        id: hash(JSON.stringify(record)), at: iso(record.at), context: text(record.agent_id) || "main",
        kind: record.event ? (record.event.includes("Compact") ? "compaction" : "session") : record.tool === "Skill" ? "skill" : "tool",
        phase: record.tool ? "end" : undefined, name: text(record.name || record.tool || record.event),
        callId: text(record.tool_use_id), childContext: text(record.child_agent_id),
        duration: number(record.duration_ms), status: record.ok === false ? "failed" : "success",
        content: content({ args: record.args, result: record.result }, allowContent),
    });
}

export function parseLine(line, format, source, allowContent = false) {
    let input;
    try { input = JSON.parse(line); } catch { throw new Error("Invalid JSON record"); }
    if (!input || typeof input !== "object") throw new Error("Expected a JSON object");
    return format === "harness" ? [harnessRecord(input, source, allowContent)] : otelRecords(input, source, allowContent);
}

export function project(records) {
    const unique = [...new Map(records.map(r => [r.id, r])).values()].sort((a, b) => a.at.localeCompare(b.at));
    const nodes = [], calls = new Map(), accounting = new Set();
    for (const r of unique) {
        if (r.kind === "model" && r.accountingId) {
            if (accounting.has(r.accountingId)) continue;
            accounting.add(r.accountingId);
        }
        const callKey = r.callId ? `${r.kind}:${r.context || "main"}:${r.callId}` : null;
        if (r.phase === "end" && callKey && calls.has(callKey)) {
            const node = calls.get(callKey);
            node.duration = r.duration ?? Math.max(0, Date.parse(r.at) - Date.parse(node.at));
            node.status = r.status;
            node.phase = "complete";
            if (r.content) node.content = r.content;
            continue;
        }
        const node = { ...r };
        if (r.phase === "start") node.status = ["tool", "agent"].includes(r.kind) ? "incomplete" : "observed";
        nodes.push(node);
        if (callKey && r.phase === "start") calls.set(callKey, node);
    }
    const totals = {};
    const modelCalls = nodes.filter(r => r.kind === "model" && r.usageRole !== "aggregate");
    for (const r of modelCalls) for (const [key, value] of Object.entries(r.usage || {})) totals[key] = (totals[key] || 0) + value;
    const start = nodes.reduce((value, r) => Math.min(value, Date.parse(r.at)), Infinity);
    const end = nodes.reduce((value, r) => Math.max(value, Date.parse(r.at) + (r.duration || 0)), -Infinity);
    const aiu = nodes.filter(r => r.nanoAiu !== undefined).reduce((sum, r) => sum + r.nanoAiu, 0);
    return {
        nodes, totals, modelCalls: modelCalls.length, toolCalls: nodes.filter(r => r.kind === "tool").length,
        failures: nodes.filter(r => r.status === "failed").length,
        incomplete: nodes.filter(r => r.status === "incomplete").length,
        duration: nodes.length ? end - start : 0,
        nanoAiu: nodes.some(r => r.nanoAiu !== undefined) ? aiu : undefined,
        usageCoverage: modelCalls.length ? `${modelCalls.filter(r => r.usage).length}/${modelCalls.length} model calls report tokens` : "Per-call tokens unavailable",
        models: [...new Set(nodes.map(r => r.model).filter(Boolean))],
    };
}
