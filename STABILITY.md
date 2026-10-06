# SME package stability contract

Version 0.1.x stabilizes the distribution and the governed Lattice boundary.
It does not claim that every model-backed modality is production-complete.

## Stable-v0 surface

- Root CommonJS facade
- createLattice(config)
- LRC request and response envelope fields
- Authority and validation refusal behavior
- Evidence bundle presence on allowed and denied routes
- Replay handle presence on successful routes
- Explicit module injection through a node-id module map

Patch releases must preserve these behaviors. Breaking changes require a minor
version while the package remains below 1.0.0.

## Experimental surface

The constructors exported for SME-TXT, SME-VIS, SME-AUD, SME-VID, SME-GEN,
SME-LOG, and SME-Core preserve access to the current implementations, but their
backend configuration and output detail are not yet compatibility guarantees.
They may require optional host-provided runtimes such as ONNX, Whisper, FFmpeg,
or a governed external provider.

## Authority boundary

The package is a capability substrate. It does not own Jarvis identity, session
state, operator consent, Project Infinity law, Story Forge narrative authority,
Beatbox audio authority, or Mandala rendering authority.

Shadow consumers must not alter the primary Jarvis response. Promotion requires
observed behavioral quality, latency, evidence-link, and operator-approval gates.
