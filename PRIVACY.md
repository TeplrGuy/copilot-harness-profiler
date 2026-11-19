# Privacy

This extension sends no session data to its author, GitHub repository, cloud service, or analytics endpoint. Its renderer and API listen only on loopback. Outbound links are documentation links opened by the user.

## Default collection

Metadata from the attached Copilot SDK session includes event/session IDs, tool/skill/agent/model names, timestamps, relationships, outcomes, and reported token counters. Prompts, source files, skill bodies, tool arguments, and tool outputs are not persisted by default.

Session and tool names, IDs, and timestamps can still identify work. Metadata-only does not mean anonymous.

## Optional content

The Privacy page requires an explicit warning confirmation before enabling optional capture. It can include tool arguments/results and imported model messages. Full SDK prompt/assistant messages and skill bodies are not collected. Imports also require their own include-content checkbox.

Recognizable token/password patterns are masked before optional content is saved, and content is capped at 8,192 characters per record. Masking is incomplete; never assume a trace is safe to publish. The extension does not deliberately read credentials or request sensitive environment variables.

## Data locations

Settings, registered source paths, and normalized traces are stored beneath `$COPILOT_HOME/extensions/copilot-harness-profiler/artifacts/`. `COPILOT_HOME` defaults to `~/.copilot`.

Registered files are read-only sources. Only explicitly registered paths are followed. No home-directory or account-wide transcript scan is performed. Remote/cloud files require explicit transfer and import.

History remains until explicitly deleted. There is no silent automatic pruning. File imports and trace reads are bounded at 32 MiB; oversized files produce actionable diagnostics.

Pause stops future SDK capture and file following, not the originating client's exporter. Removing a source retains history and originals. Deleting a session removes only its exact profiler-owned trace; registered originals may reimport it. Disabling content does not erase older content.

## Sharing

The public repository contains code, documentation and synthetic tests, not actual user traces. Repository installation does not share session data.

An installed extension's `artifacts` folder is private. Share the repository URL or a **clean code-only package**, not an unreviewed live installation folder. A generic gist sharing tool may include data folders.

Session exports require an explicit local preview/download. Export labels omit registered source paths and pseudonymize session/context IDs, but names and opted-in content can remain identifying. Review all exports before sharing them.

## Policies and permissions

The extension does not modify enterprise-managed settings, auto-approve agent operations, or change prompts/results. Client telemetry settings and capture restrictions remain authoritative. Setup instructions are previews for user review, not automatic changes to other applications.
