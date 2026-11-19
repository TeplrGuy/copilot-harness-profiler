const token = location.hash.slice(1);
const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const count = n => n === undefined ? "Unavailable" : new Intl.NumberFormat(undefined, { notation: n > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
const duration = n => n === undefined ? "Unknown" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
let state, selected, trace, fingerprint, busy = false;
let viewMode = "sequence", allTools = true, inspectedId, lastInteraction = 0;
const expanded = new Map();
const sessionElements = new Map();
for (const type of ["pointerdown", "input", "keydown"]) document.addEventListener(type, () => { lastInteraction = Date.now(); });
function error(message) { $("#error").hidden = !message; $("#error").textContent = message || ""; }
async function api(path, body) {
    const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}
const action = (name, input) => api("/api/action", { action: name, input });
function button(text, callback) {
    const node = el("button", text);
    node.type = "button";
    node.addEventListener("click", async () => {
        node.disabled = true;
        try { error(""); await callback(); } catch (e) { error(e.message); }
        finally { node.disabled = false; }
    });
    return node;
}
function showTab(name) {
    for (const tab of document.querySelectorAll(".tab")) {
        const active = tab.dataset.tab === name;
        tab.classList.toggle("active", active);
        if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    }
    for (const view of ["sessions", "sources", "privacy"]) $(`#${view}-view`).hidden = view !== name;
}
document.querySelectorAll("[data-tab]").forEach(node => node.addEventListener("click", () => showTab(node.dataset.tab)));
document.querySelectorAll("[data-show]").forEach(node => node.addEventListener("click", () => showTab(node.dataset.show)));
function options(selector, values) {
    const select = $(selector), current = select.value;
    const sorted = [...new Set(values)].sort(), signature = JSON.stringify(sorted);
    if (select.dataset.options === signature) return;
    select.dataset.options = signature;
    while (select.options.length > 1) select.remove(1);
    for (const value of sorted) {
        const option = el("option", value); option.value = value; select.append(option);
    }
    select.value = current;
}
function metric(value, label) {
    const box = el("div", undefined, "metric");
    box.append(el("strong", value), el("span", label));
    return box;
}
function renderState() {
    const { sessions, settings } = state;
    $("#capture-status").textContent = settings.paused ? "Capture paused" : "Local capture active";
    $("#capture-status").classList.toggle("live", !settings.paused);
    $("#version").textContent = `v${state.version}`;
    $("#paused").checked = settings.paused;
    $("#content").checked = settings.content;
    $("#storage").textContent = `Local storage: ${settings.storage}`;
    const totals = sessions.reduce((sum, s) => ({ tools: sum.tools + s.toolCalls, failures: sum.failures + s.failures, output: sum.output + (s.totals.output || 0), hasOutput: sum.hasOutput || s.totals.output !== undefined }), { tools: 0, failures: 0, output: 0, hasOutput: false });
    $("#metrics").replaceChildren(
        metric(count(sessions.length), "Observed sessions"),
        metric(count(totals.tools), "Tool executions"),
        metric(count(totals.failures), "Recorded failures"),
        metric(totals.hasOutput ? count(totals.output) : "Unavailable", "Reported output tokens (partial coverage)"),
    );
    options("#source-filter", sessions.map(s => s.source));
    options("#model-filter", sessions.flatMap(s => s.models));
    renderSessions();
    $("#coverage").replaceChildren(...state.coverage.map(source => {
        const card = el("div", undefined, "card");
        const observed = sessions.filter(s => s.surface === source.id);
        const registered = settings.sources.filter(s => s.surface === source.id).length;
        const status = observed.length ? (source.id === "copilot-sdk" ? "SDK events received" : "Recorded / imported data") : registered ? "Configured / waiting for data" : source.status;
        card.append(el("h3", source.name), el("span", status, "badge"), el("p", source.capability), el("p", source.detail));
        if (observed.length) card.append(el("p", `${observed.length} observed sessions / latest ${new Date(observed[0].last).toLocaleString()}. ${[...new Set(observed.flatMap(s => s.versions))].join(", ") || "Version not reported"}. Source labels are user-supplied; receipt is not a full verification.`, "muted"));
        return card;
    }));
    $("#registered").replaceChildren(...settings.sources.map(source => {
        const row = el("div", undefined, "source-row");
        row.append(el("strong", source.label), el("p", source.path, "mono"), button("Stop following (retain history)", async () => { await action("remove", { id: source.id }); await refresh(); }));
        return row;
    }));
    if (!settings.sources.length) $("#registered").append(el("p", "No files registered. Attached-session SDK collection is independent of this list."));
    $("#diagnostics").replaceChildren(...state.errors.map(e => el("p", `${new Date(e.at).toLocaleTimeString()} - ${e.message}`)));
    if (!state.errors.length) $("#diagnostics").append(el("p", "No collection errors reported. This does not verify unconfigured sources."));
    const separator = settings.storage.includes("\\") ? "\\" : "/";
    const exportPath = `${settings.storage}${separator}exports${separator}cli.jsonl`;
    $("#cli-setup").textContent = `$env:COPILOT_OTEL_FILE_EXPORTER_PATH = '${exportPath.replace(/'/g, "''")}'\n$env:OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = 'NO_CONTENT'\ncopilot`;
    $("#vscode-setup").textContent = JSON.stringify({
        "github.copilot.chat.otel.enabled": true,
        "github.copilot.chat.otel.exporterType": "file",
        "github.copilot.chat.otel.captureContent": false,
        "github.copilot.chat.otel.outfile": exportPath.replace("cli.jsonl", "vscode.jsonl"),
    }, null, 2);
}
function renderSessions() {
    const query = $("#search").value.toLowerCase(), source = $("#source-filter").value, model = $("#model-filter").value, since = $("#since").value, outcome = $("#outcome").value;
    const filtered = state.sessions.filter(s =>
        (!query || `${s.sessionId} ${s.source} ${s.models.join(" ")}`.toLowerCase().includes(query)) &&
        (!source || s.source === source) && (!model || s.models.includes(model)) &&
        (!since || s.start >= since) && (!outcome || (outcome === "failed" ? s.failures > 0 : s.incomplete > 0)));
    $("#session-count").textContent = `${filtered.length} shown`;
    const list = $("#session-list"), keys = new Set(filtered.map(s => s.key));
    for (const child of [...list.children]) if (!keys.has(child.dataset.key)) child.remove();
    filtered.forEach((s, index) => {
        let node = sessionElements.get(s.key);
        if (!node) {
            node = button("", () => selectSession(s.key));
            node.dataset.key = s.key;
            node.append(el("strong"), el("small"), el("small"), el("small"));
            sessionElements.set(s.key, node);
        }
        node.className = `session${selected === s.key ? " selected" : ""}`;
        [s.sessionId.slice(0, 30), s.source, `${new Date(s.start).toLocaleString()} / ${duration(s.duration)}`, `${s.toolCalls} tools / ${s.failures} failures / ${s.events} events`].forEach((value, i) => { if (node.children[i].textContent !== value) node.children[i].textContent = value; });
        node.setAttribute("aria-label", `Inspect session ${s.sessionId}`);
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
    });
    if (!filtered.length) list.append(el("p", "No sessions match. Check capture or import a trace.", "muted"));
}
for (const id of ["search", "source-filter", "model-filter", "since", "outcome"]) $(`#${id}`).addEventListener("input", renderSessions);
async function selectSession(key) {
    if (selected !== key) { expanded.clear(); inspectedId = undefined; }
    selected = key;
    trace = await api(`/api/trace?key=${encodeURIComponent(key)}`);
    fingerprint = state.sessions.find(s => s.key === key)?.events;
    renderSessions();
    renderTrace();
}
function nodeDescription(node) {
    inspectedId = node.id;
    const fields = { type: node.kind, status: node.status || "observed", duration: duration(node.duration), model: node.model || "Unavailable", context: node.context || "Unknown", parent: node.parentSpanId || node.parentCallId || node.parentContext || "Not recorded / root", at: node.at };
    const box = $("#node-detail"); box.hidden = false;
    box.replaceChildren(el("h3", node.name || node.kind), el("pre", JSON.stringify(fields, null, 2)));
    if (node.usage) box.append(el("h4", `Reported counters${node.usageRole === "aggregate" ? " (aggregate; excluded from totals)" : ""}`), el("pre", JSON.stringify(node.usage, null, 2)));
    if (node.content) box.append(el("h4", "Opted-in content / review before sharing"), el("pre", node.content));
}
function parentMaps(nodes) {
    const spans = new Map(nodes.filter(n => n.spanId).map(n => [n.spanId, n]));
    const tools = new Map(nodes.filter(n => n.kind === "tool" && n.callId).map(n => [n.callId, n]));
    const agents = new Map(nodes.filter(n => n.kind === "agent" && n.phase !== "end" && n.context).map(n => [n.context, n]));
    const parents = new Map();
    for (const n of nodes) {
        let parent = spans.get(n.parentSpanId) || tools.get(n.parentCallId);
        if (!parent && n.kind === "agent") parent = tools.get(n.callId) || agents.get(n.parentContext);
        if (!parent && n.kind !== "agent" && n.context !== "main") parent = agents.get(n.context);
        if (parent && parent !== n) parents.set(n.id, parent);
    }
    return parents;
}
function renderTrace() {
    const host = $("#detail"), head = el("div", undefined, "detail-head");
    head.append(el("span", trace.source, "eyebrow"), el("h2", trace.sessionId));
    const summary = el("div", undefined, "detail-summary");
    summary.append(el("span", `${duration(trace.duration)} observed wall time`), el("span", `${trace.toolCalls} tools / ${trace.failures} failed`), el("span", trace.usageCoverage));
    const counters = el("p", `Input ${count(trace.totals.input)} / output ${count(trace.totals.output)} / cache reads ${count(trace.totals.cacheRead)}`, "muted");
    head.append(summary, counters, el("p", "Counters retain source meanings. Context origin and missing relationships are not inferred. Skill-specific token cost is unavailable.", "muted"));
    const actions = el("div", undefined, "detail-actions");
    const update = el("span", "", "muted"); update.id = "trace-update";
    actions.append(button("Refresh trace", () => selectSession(selected)), update);
    actions.append(button("Preview export", () => exportSession(false)));
    if (state.settings.content) actions.append(button("Preview export with content", () => exportSession(true)));
    actions.append(button("Delete stored session", async () => {
        if (!confirm("Delete only this profiler-owned session? Original files remain and registered sources may reimport it.")) return;
        await action("delete", { key: selected, confirm: selected }); selected = null; trace = null;
        host.replaceChildren(el("p", "Stored session deleted. Original source was not changed.")); await refresh();
    }));
    head.append(actions);
    const toolbar = el("div", undefined, "trace-toolbar");
    const sequenceButton = button("Sequence", () => { viewMode = "sequence"; $("#sequence").hidden = false; $("#tree").hidden = true; });
    const treeButton = button("Call tree", () => { viewMode = "tree"; $("#sequence").hidden = true; $("#tree").hidden = false; });
    const label = el("label", undefined, "inline"), all = el("input");
    all.type = "checkbox"; all.checked = allTools; label.append(all, document.createTextNode("All tools"));
    toolbar.append(sequenceButton, treeButton, label);
    const sequence = el("div", undefined, "sequence"); sequence.id = "sequence"; sequence.hidden = viewMode !== "sequence";
    const tree = el("div", undefined, "tree"); tree.id = "tree"; tree.hidden = viewMode !== "tree";
    const detail = el("div", undefined, "node-detail"); detail.id = "node-detail"; detail.hidden = true;
    host.replaceChildren(head, toolbar, sequence, tree, detail);
    const draw = () => {
        allTools = all.checked;
        const nodes = trace.nodes.filter(n => all.checked || n.kind !== "tool").slice(0, 500);
        const parents = parentMaps(trace.nodes);
        drawSequence(sequence, nodes, parents);
        drawTree(tree, nodes, parents);
        const inspected = trace.nodes.find(n => n.id === inspectedId);
        if (inspected) nodeDescription(inspected);
    };
    all.addEventListener("change", draw); draw();
}
function drawSequence(host, nodes, parents) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Execution sequence; rows show ordering, not a time scale");
    function context(n) {
        let current = n, seen = new Set();
        while (current && !seen.has(current.id)) {
            seen.add(current.id);
            if (current.kind === "agent" && current.spanId) return `${current.name || "Agent"} / ${current.spanId.slice(0, 5)}`;
            current = parents.get(current.id);
        }
        return n.context || "Unknown context";
    }
    const lanes = [...new Set(nodes.map(context))];
    const width = Math.max(550, lanes.length * 190 + 80), height = 80 + nodes.length * 34;
    svg.setAttribute("width", width); svg.setAttribute("height", Math.max(180, height));
    const add = (tag, attrs, text, parent = svg) => {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        if (text !== undefined) n.textContent = text;
        parent.append(n); return n;
    };
    lanes.forEach((lane, i) => {
        const x = 70 + i * 190;
        add("line", { x1: x, x2: x, y1: 45, y2: height, class: "lane" });
        add("text", { x: x - 45, y: 25 }, lane.slice(0, 24));
    });
    nodes.forEach((n, i) => {
        const x = 70 + lanes.indexOf(context(n)) * 190, y = 65 + i * 34;
        const group = add("g", { class: "event", tabindex: 0, role: "button", "aria-label": `${n.kind}: ${n.name || n.kind}` });
        const color = n.status === "failed" ? "#cf222e" : ["#0969da", "#8250df", "#1a7f37", "#bf8700"][Math.max(0, lanes.indexOf(context(n))) % 4];
        const parent = parents.get(n.id), from = parent ? 70 + lanes.indexOf(context(parent)) * 190 : x;
        if (from >= 70 && from !== x) add("line", { x1: from, x2: x, y1: y, y2: y, stroke: color }, undefined, group);
        add("rect", { x: x - 5, y: y - 9, width: 10, height: 18, rx: n.kind === "skill" ? 0 : 4, fill: color }, undefined, group);
        add("text", { x: x + 12, y: y + 4 }, `${n.name || n.kind}`.slice(0, 29));
        add("title", {}, `${n.kind}: ${n.name || ""}\n${duration(n.duration)} / ${n.status || "observed"}`, group);
        group.addEventListener("click", () => nodeDescription(n));
        group.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); nodeDescription(n); } });
    });
    host.replaceChildren(el("p", "Event order, not a time scale. Up to 500 records shown; totals use the full trace.", "muted"), svg);
}
function drawTree(host, nodes, parents) {
    const children = new Map(), visible = new Set(nodes.map(n => n.id));
    for (const n of nodes) {
        const p = parents.get(n.id), key = p && visible.has(p.id) ? p.id : "root";
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(n);
    }
    const seen = new Set();
    const render = (node, depth) => {
        if (seen.has(node.id) || depth > 30) return el("p", "Cyclic or deeply nested relationship omitted", "muted");
        seen.add(node.id);
        const row = el("span", undefined, `node-row${node.status === "failed" ? " failed" : ""}`);
        row.append(el("span", node.kind, "kind"), button(node.name || node.kind, () => nodeDescription(node)), el("span", node.status === "incomplete" ? "incomplete" : duration(node.duration), "duration"));
        if (!children.has(node.id)) return row;
        const details = el("details"), summary = el("summary"); details.open = expanded.get(node.id) ?? depth < 1;
        details.addEventListener("toggle", () => expanded.set(node.id, details.open));
        summary.append(row); details.append(summary, ...children.get(node.id).map(n => render(n, depth + 1)));
        return details;
    };
    host.replaceChildren(el("p", "Parents come from identifiers, never timing overlap. Missing parents stay at the root.", "muted"), ...(children.get("root") || []).map(n => render(n, 0)));
    for (const node of nodes) if (!seen.has(node.id)) host.append(render(node, 0));
}
async function exportSession(includeContent) {
    if (includeContent && !confirm("This export can include source code, arguments, prompts and secrets. Continue to a local preview only?")) return;
    const payload = await action("export", { key: selected, content: includeContent });
    const box = el("div", undefined, "export-preview"), text = JSON.stringify(payload, null, 2), preview = el("textarea");
    preview.readOnly = true; preview.value = text; preview.setAttribute("aria-label", "Export preview");
    box.append(el("h3", "Review before downloading"), el("p", payload.warning), preview, button("Download reviewed JSON", () => {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = el("a"); link.href = url; link.download = `${payload.session}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }), button("Close preview", () => box.remove()));
    $("#detail").append(box); box.scrollIntoView({ block: "nearest" });
}
$("#import-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
        error("");
        const preview = await action("preview", { path: $("#import-path").value, format: $("#import-format").value, surface: $("#import-surface").value, label: $("#import-label").value, content: $("#import-content").checked });
        const host = $("#import-preview");
        host.replaceChildren(el("p", `${preview.records} supported records / ${preview.sessions} sessions / ${preview.ignored} non-span records ignored. Content ${preview.content ? "included" : "discarded"}. Preview expires in five minutes.`),
            button("Import once", async () => { await action("import", { id: preview.id }); host.replaceChildren(el("p", "Imported. Original file unchanged.")); await refresh(); }),
            button("Follow this file", async () => { await action("register", { id: preview.id }); host.replaceChildren(el("p", "Registered for local ingestion.")); await refresh(); }));
    } catch (e) { error(e.message); }
});
$("#paused").addEventListener("change", async event => {
    try { await action("configure", { paused: event.target.checked }); await refresh(); } catch (e) { error(e.message); }
});
$("#content").addEventListener("change", async event => {
    const enabled = event.target.checked;
    if (enabled && !confirm("Content can include prompts, source code, arguments, outputs and secrets. Masking is imperfect. Enable content capture for future records on this machine?")) { event.target.checked = false; return; }
    try { await action("configure", { content: enabled, confirm: enabled ? "I understand content may contain secrets" : undefined }); await refresh(); } catch (e) { error(e.message); }
});
async function refresh() {
    if (busy) return;
    busy = true;
    try {
        state = await api("/api/state"); renderState();
        if (selected && $("#trace-update")) $("#trace-update").textContent = state.sessions.find(s => s.key === selected)?.events !== fingerprint ? "New events available" : "";
    } catch (e) { error(e.message); }
    finally { busy = false; }
}
$("#refresh").addEventListener("click", async () => { await refresh(); if (selected) await selectSession(selected); });
if (!token) error("Missing canvas capability. Reopen this canvas from Copilot.");
else {
    refresh();
    const events = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    events.addEventListener("refresh", () => { if (Date.now() - lastInteraction > 1500) refresh(); });
    events.onerror = () => { $("#capture-status").textContent = "Viewer reconnecting"; };
    window.addEventListener("beforeunload", () => events.close());
}
