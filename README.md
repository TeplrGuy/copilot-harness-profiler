# Copilot Harness Profiler

A local-first, installable **GitHub Copilot canvas** for understanding agent execution: tool calls, skills, subagents, model calls, timings, failures, and reported token usage.

Inspired by [Harness Profiler](https://github.com/afurmanov/harness-profiler). Its Claude-specific collector is not reused or relabeled as Copilot capture.

## Install as a personal canvas

Requires a Copilot app/runtime with extension canvases and the `@github/copilot-sdk/extension` API, plus Node 22 or newer. Canvas APIs are experimental. A regular web browser or GitHub Pages cannot install a Copilot canvas.

In Copilot, ask:

> Install this canvas extension in my user scope:
> https://github.com/TeplrGuy/copilot-harness-profiler/tree/v0.1.0/.github/extensions/copilot-harness-profiler

Use the supported **Install extension** flow, review the code, and select user scope. The extension folder needs no `npm install`; Copilot supplies its SDK. Then ask:

> Open Copilot Harness Profiler.

The extension contributes `get_status`, `list_sessions`, `get_trace`, and `refresh` canvas actions. It records metadata from its **attached session** and replays available history. Each eligible new Copilot session loads the user extension independently. Existing sessions may need extension reload; a user installation does not retrofit every running client.

## What you see

- Session explorer with source, model, date, and failure/incomplete-call filters.
- A context sequence diagram and expandable identifier-linked call tree.
- Tool, skill, agent, model, and compaction details where actually reported.
- Separate input, output, cache, and reasoning token counters. Missing counters are **unavailable**, not zero.
- Source setup guidance, collection diagnostics, pause, optional content capture, and reviewed exports.

Session summaries update while capture runs. An open trace stays stable while you inspect it; **New events available** prompts you to use **Refresh trace** without losing your tree expansion or selected view.

Up to 500 records are rendered per trace for responsiveness; totals use the full stored trace. Per-session reads and individual file imports are limited to 32 MiB. There is no automatic history pruning or upload.

## Coverage is explicit, not universal

| Surface | Available route | Verification in this release |
| --- | --- | --- |
| Copilot app / attached shared runtime | SDK events and replay | Real attached Windows session; tools, skills, failures, replay and persistence observed |
| Copilot CLI | Shared-runtime OpenTelemetry JSONL file export | Real Windows CLI export, including a nested explore agent and its model/tool calls |
| VS Code Copilot / Agent Host | Shared-runtime/wrapper spans; actual exporter depends on host/policy | Schema supported; verify your installed host |
| VS Code Local harness | VS Code OpenTelemetry file exporter | Adapter fixtures; not a claim of a live editor run |
| Remote hosts / containers / cloud agent | Explicitly transferred supported JSONL exports | Import route only; no automatic host instrumentation |
| Harness Profiler / Claude | Version 2 JSONL compatibility import | Focused adapter test; no Claude transcript token inference |
| Other IDEs, GitHub web chat, mobile, inline completion | No verified universal session-level export | Not supported as a full execution profiler |

This is not an account-wide Copilot session API. A source configured successfully is not automatically end-to-end verified. Remote files are on their execution host. Historical SDK per-call usage may be absent because `assistant.usage` is ephemeral.

## Add a file source

Open **Sources & setup**. Enter an absolute JSONL path, select OpenTelemetry or Harness Profiler v2, and preview. Choose **Import once** or **Follow this file**. Content is discarded unless both the global opt-in and the import's content option are enabled.

Following polls while any extension provider is running. The source client can keep exporting while the canvas is closed. With no provider running, source files accumulate and are ingested later. Data is deduplicated by source/session/event identity. Importing the same trace under a different file/source intentionally creates a separate provenance entry; it does not merge unrelated clients by time.

### Copilot CLI (PowerShell)

Set the file destination only in the shell that will launch a **new** CLI process:

```powershell
$env:COPILOT_OTEL_FILE_EXPORTER_PATH = "$HOME\copilot-traces\cli.jsonl"
$env:OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = "NO_CONTENT"
copilot
```

Create the parent folder if the exporter requires it. Do not overwrite an existing telemetry destination without reviewing your configuration and policies. Register the output file only after it contains a test span.

### VS Code Local harness

Merge these fields into your user settings, preserving other settings:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.captureContent": false,
  "github.copilot.chat.otel.outfile": "C:\\copilot-traces\\vscode.jsonl"
}
```

Use a real writable path on the execution host. These Local-harness settings are **not a guarantee** that Agent Host exports to the same file. Confirm the selected harness, installed version, and actual output. Restart/reload only when appropriate for your client.

### Desktop app / managed hosts

The installed extension observes the attached SDK session without changing enterprise telemetry settings. Broader file export must use the client's supported route. Managed OTel file/endpoint configuration may require an administrator; this canvas does not edit policy, restart other clients, or replace existing exporters.

### Remote/cloud

Capture and retain a supported export on that host using your approved workflow. Cloud hook output can be partial and ephemeral. Transfer the resulting JSONL file explicitly and import it. No cloud account credentials, authenticated sync service, or automatic artifact publishing are used.

References: [shared-runtime OTel](https://docs.github.com/en/copilot/reference/enterprise-administrators/opentelemetry-reference), [VS Code monitoring](https://code.visualstudio.com/docs/agents/guides/monitoring-agents), [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).

## Accounting and relationship rules

Model-call counters, not agent/wrapper aggregate counters, contribute to token totals. Input and cache counters are displayed independently without assuming every provider's input counter excludes cache. Root AI-unit observations are retained separately; `github.copilot.cost` is **not money** and is never displayed as a currency.

Parent links come from span IDs, call IDs, and reported agent context IDs—not temporal containment. Fresh/copy context origin and skill-specific token cost are not invented. Wall time spans the observed interval; it is not the sum of parallel calls. Imported Claude v2 calls currently do not reconstruct Claude transcript spending.

## Privacy and storage

See [PRIVACY.md](PRIVACY.md). Persistent data lives under:

```text
$COPILOT_HOME/extensions/copilot-harness-profiler/artifacts/
```

`COPILOT_HOME` defaults to `~/.copilot`. It is independent of panel IDs and survives panel/extension restarts.

The HTTP renderer binds only to `127.0.0.1` on an ephemeral port. APIs require a random capability and reject foreign origins/hosts. There is no remote ingestion listener.

Turning content capture off affects future persistence, not previously saved content. Source removal retains both original files and imported history. Session deletion targets only an exact profiler-owned trace. A registered original can reimport deleted history; stop following it first.

## Share and install elsewhere

Share the **repository-folder install URL above**. It contains only extension code and assets.

**Do not blindly share the folder of a live user installation as a gist:** its `artifacts` subfolder contains private data. For gist distribution, use a clean code-only copy of the versioned extension folder, include `copilot-extension.json`, and use the supported extension share/install flow on that clean copy. Never include `artifacts`, settings, exports, or traces. Installing extension code does not transfer your sessions.

A session export is separate: select a session, preview the redacted JSON, inspect it, and download only after review. Optional content exports require a further warning. Export JSON is a review artifact, not currently a round-trip import format.

## Uninstall

Remove this extension through Copilot's extension management or delete only its `extension.mjs` and packaged code files from your user extension folder. Reload extensions. Keep `artifacts` if you want to retain history. Delete only that explicitly identified data folder if you want to remove the history as well.

Remove any exporter configuration you enabled separately. The canvas does not silently undo another client's settings or delete original exports.

## Development

```powershell
npm test
npm run check
```

No production npm dependencies. Installable source is in `.github/extensions/copilot-harness-profiler`; tests are outside that folder. Canvas registration started from the installed SDK's canvas scaffold.

If extension loading fails, use `extensions_manage` list/inspect and its provider log. Capture/import diagnostics also appear in **Sources & setup**. A profiler failure is reported without changing tool permissions or agent output.

### Release validation

The initial release was exercised on Windows with Node 26 and a Copilot extension-capable runtime:

- Real attached-session capture, extension reload, and browser reload retained recorded history.
- Two metadata-only CLI exports were imported through the UI. The nested-agent run showed two tools, four model calls, zero recorded failures, and the identifier-linked task → explore → model/tool relationship.
- Browser interaction covered session search and selection, sequence and expandable tree views, stable inspection during refresh, coverage cards, and reviewed export preview.
- Fifteen automated tests cover adapters, accounting, deduplication, persistence, content consent/redaction, partial-line following/truncation, deletion boundaries, import revisions, and HTTP access controls.
- The published `v0.1.0` folder was installed into a clean session extension scope. All ten package files matched the source after line-ending normalization; discovery, open/actions, rendering, and access to persisted history passed.

These observations do not verify a live VS Code editor, remote/cloud capture, every SDK event type, or canvas rendering on other operating systems. The automated CI matrix passed Node 22/24 on both Windows and Linux.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
