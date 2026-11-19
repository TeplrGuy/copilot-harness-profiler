import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, sdkRecord, parseLine, project, redact } from "./normalize.mjs";

const MAX_FILE = 32 * 1024 * 1024;
export const defaultHome = () => join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "copilot-harness-profiler", "artifacts");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
function atomic(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
}
export class Store {
    constructor(home = defaultHome()) {
        this.home = home;
        this.data = join(home, "traces");
        mkdirSync(this.data, { recursive: true, mode: 0o700 });
        this.seen = new Map();
        this.errors = [];
    }
    settings() {
        const path = join(this.home, "settings.json");
        return existsSync(path) ? readJson(path) : { paused: false, content: false, sources: [] };
    }
    configure(patch) {
        if (typeof patch.content === "boolean" && patch.content && patch.confirm !== "I understand content may contain secrets") throw new Error("Explicit content warning confirmation required");
        const settings = this.settings();
        if (typeof patch.paused === "boolean") settings.paused = patch.paused;
        if (typeof patch.content === "boolean") settings.content = patch.content;
        atomic(join(this.home, "settings.json"), settings);
        return this.publicSettings();
    }
    publicSettings() {
        const s = this.settings();
        return { ...s, storage: this.home, sources: s.sources.map(source => ({ ...source, displayPath: source.path })) };
    }
    append(record) {
        if (!record) return;
        const key = hash(`${record.source}:${record.sessionId}`);
        const path = join(this.data, `${key}.jsonl`);
        let seen = this.seen.get(key);
        if (!seen) {
            seen = new Set(existsSync(path) ? this.readRecords(path).map(r => r.id) : []);
            this.seen.set(key, seen);
        }
        if (seen.has(record.id)) return;
        appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        seen.add(record.id);
    }
    capture(event, sessionId) {
        const settings = this.settings();
        if (!settings.paused) this.append(sdkRecord(event, sessionId, settings.content));
    }
    diagnostic(error) {
        const message = redact(error.message || error).slice(0, 500);
        if (this.errors.at(-1)?.message !== message) this.errors.push({ at: new Date().toISOString(), message });
        this.errors = this.errors.slice(-20);
    }
    readRecords(path) {
        const size = statSync(path).size;
        if (size > MAX_FILE) throw new Error(`Trace exceeds the 32 MiB read limit: ${basename(path)}. Split or archive it explicitly.`);
        return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    }
    files() { return readdirSync(this.data).filter(name => /^[a-f0-9]{64}\.jsonl$/.test(name)); }
    sessions() {
        const sessions = [];
        for (const file of this.files()) {
            try {
                const records = this.readRecords(join(this.data, file));
                if (!records.length) continue;
                const trace = project(records);
                sessions.push({
                    key: file.slice(0, -6), sessionId: records[0].sessionId, source: records[0].source, surface: records.find(r => r.surface)?.surface || (records[0].source === "copilot-sdk" ? "copilot-sdk" : "unknown"),
                    start: records.map(r => r.at).sort()[0], last: records.map(r => r.at).sort().at(-1),
                    events: records.length, bytes: statSync(join(this.data, file)).size,
                    versions: [...new Set(records.map(r => r.version).filter(Boolean))],
                    ...Object.fromEntries(Object.entries(trace).filter(([key]) => key !== "nodes")),
                });
            } catch (error) { this.diagnostic(error); }
        }
        return sessions.sort((a, b) => b.last.localeCompare(a.last));
    }
    trace(key) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid session key");
        const records = this.readRecords(join(this.data, `${key}.jsonl`));
        return { sessionId: records[0]?.sessionId, source: records[0]?.source, ...project(records) };
    }
    previewImport({ path, format, label, content = false, surface = "remote" }) {
        if (!isAbsolute(path || "")) throw new Error("Select an absolute JSONL file path");
        if (!["otel", "harness"].includes(format)) throw new Error("Choose otel or harness format");
        if (!["cli", "vscode", "local", "remote", "harness"].includes(surface)) throw new Error("Choose a supported source surface");
        if (content && !this.settings().content) throw new Error("Enable optional content capture after reviewing the warning first");
        const canonical = resolve(path);
        const size = statSync(canonical).size;
        if (size > MAX_FILE) throw new Error("Import limit is 32 MiB; split larger files first");
        const bytes = readFileSync(canonical);
        const source = `${format}:${String(label || basename(canonical)).slice(0, 80)}:${hash(canonical).slice(0, 10)}`;
        const records = [], errors = [];
        let ignored = 0;
        const lines = bytes.toString("utf8").replace(/^\uFEFF/, "").split("\n");
        lines.forEach((line, index) => {
            if (!line.trim()) return;
            try {
                const parsed = parseLine(line, format, source, content);
                if (!parsed.length) ignored++;
                records.push(...parsed.map(record => ({ ...record, surface: format === "harness" ? "harness" : surface })));
            } catch (error) { errors.push(`Line ${index + 1}: ${error.message}`); }
        });
        if (errors.length) throw new Error(errors.slice(0, 5).join("; "));
        if (!records.length) throw new Error(`No supported span/trace records found (${ignored} non-span records ignored)`);
        return { path: canonical, format, label, content, surface, source, digest: hash(bytes), records, ignored, size };
    }
    applyImport(input) {
        const preview = this.previewImport(input);
        if (preview.digest !== input.digest) throw new Error("File changed after preview; preview it again");
        for (const record of preview.records) this.append(record);
        return { imported: preview.records.length, ignored: preview.ignored, source: preview.source };
    }
    register(input) {
        const preview = this.previewImport(input);
        if (preview.digest !== input.digest) throw new Error("File changed after preview");
        const settings = this.settings();
        const id = hash(preview.path);
        settings.sources = settings.sources.filter(s => s.id !== id);
        settings.sources.push({ id, path: preview.path, label: String(input.label || basename(preview.path)).slice(0, 80), format: preview.format, surface: preview.surface, source: preview.source, offset: 0, content: preview.content });
        atomic(join(this.home, "settings.json"), settings);
        return { registered: id };
    }
    removeSource(id) {
        const settings = this.settings();
        settings.sources = settings.sources.filter(s => s.id !== id);
        atomic(join(this.home, "settings.json"), settings);
        return { removed: id, note: "Original file and imported history were retained." };
    }
    refresh() {
        const settings = this.settings();
        if (settings.paused) return;
        // Offsets are per provider, so multiple sessions never race on shared settings.
        this.offsets ??= new Map();
        for (const source of settings.sources) {
            try {
                const stat = statSync(source.path);
                const previous = this.offsets.get(source.id);
                let offset = previous?.offset || 0;
                if (stat.size < offset || previous?.ino !== stat.ino) offset = 0;
                if (stat.size - offset > MAX_FILE) throw new Error(`Source ${source.label} has more than 32 MiB pending; import a bounded export`);
                const buffer = Buffer.alloc(stat.size - offset);
                const fd = openSync(source.path, "r");
                let count;
                try { count = readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
                const end = buffer.subarray(0, count).lastIndexOf(10);
                if (end < 0) continue;
                for (const line of buffer.subarray(0, end).toString("utf8").replace(/^\uFEFF/, "").split("\n")) {
                    if (!line.trim()) continue;
                    for (const record of parseLine(line, source.format, source.source, source.content && settings.content)) this.append({ ...record, surface: source.format === "harness" ? "harness" : source.surface });
                }
                this.offsets.set(source.id, { offset: offset + end + 1, ino: stat.ino });
            } catch (error) { this.diagnostic(new Error(`${source.label}: ${error.message}`)); }
        }
    }
    exportTrace(key, includeContent = false) {
        if (includeContent && !this.settings().content) throw new Error("Enable optional content capture after reviewing the warning first");
        const trace = this.trace(key);
        const session = `session-${hash(trace.sessionId).slice(0, 8)}`;
        const records = trace.nodes.map(node => {
            const { content, sessionId, source, ...rest } = node;
            const result = {
                ...rest, sessionId: session, source: String(source).split(":")[0],
                name: String(node.name || node.kind).replace(/[A-Za-z]:\\[^\s]+|\/(?:Users|home)\/[^\s]+/g, "[PATH]"),
                context: node.context ? hash(node.context).slice(0, 12) : undefined,
                parentContext: node.parentContext ? hash(node.parentContext).slice(0, 12) : undefined,
                childContext: node.childContext ? hash(node.childContext).slice(0, 12) : undefined,
            };
            if (includeContent && content) result.content = redact(content);
            return result;
        });
        return { format: "copilot-harness-profiler-export-v1", warning: "Review before sharing. Names and optional content can still identify your work.", session, records };
    }
    deleteTrace(key, confirm) {
        if (confirm !== key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Exact session-key confirmation required");
        // Only the profiler-owned, exact trace path is eligible for deletion.
        return import("node:fs").then(({ unlinkSync }) => {
            unlinkSync(join(this.data, `${key}.jsonl`));
            this.seen.delete(key);
            return { deleted: key, note: "Registered originals can reimport this session. Remove its source first to prevent that." };
        });
    }
}
