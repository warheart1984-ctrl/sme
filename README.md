# SME

Sovereign Multimodal Engine — a governed runtime for routing text, image,
audio, and video substrates through the Mandala constitutional spine:

Authority → Validation → Decision → Evidence → Verification → Replay → Audit.

Extracted from `G:\Mandala Rendering Software` (2026-10-06) into its own
repository. The package, C++ native suite, and specification documents live
here; the model weights do not — the package boundary contract forbids them
(see STABILITY.md and `scripts/verify-pack.js`).

## Layout

- `package.json` — `@mandala/sme` (CommonJS, zero runtime dependencies)
- `sme-suite/` — C++ native companion (CMake; see its README)
- `docs/` — SME-SPEC.md, SME-IMPLEMENTATION-PLAN.md, and governance white paper
- `scripts/verify-pack.js` — clean-package compliance gate (no weights/binaries)

## Verify

    npm test          # lattice + package boundary tests (no model deps)
    npm run pack:check   # published tarball must be < 1MB and contain no models

Note: `verify-pack.js` was patched on 2026-10-06 to run on Windows (npm runs
through `cmd.exe`); no behavioral change.