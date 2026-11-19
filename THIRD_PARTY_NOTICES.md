# Attribution

The context sequence diagram and call-tree product direction were inspired by
[Harness Profiler](https://github.com/afurmanov/harness-profiler), by Aleksandr
Furmanov, licensed under MIT. The investigated fork was
[TeplrGuy/harness-profiler](https://github.com/TeplrGuy/harness-profiler) at commit
`847bd8f6ab2a0348fd7b7057c1943e4c2fa861e8`.

No upstream recorder, transcript parser, renderer, or test implementation is
vendored in this release. The v2 JSONL adapter is an independent compatibility
implementation; it does not imply upstream affiliation.

The extension registration/server structure was bootstrapped using Copilot's
installed canvas scaffold and SDK authoring workflow. The Copilot SDK is supplied
by the host and is not redistributed in this repository.
