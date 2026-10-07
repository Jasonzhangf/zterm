# Pinned sender numeric boundary correction

Parent architecture proposal; not coding admission or implementation PASS. This supplements the pinned binding experiment without changing its source/library/toolchain pins, codec snapshot, SSRC projection, transport or quality transaction ownership. Independent bounded design review must pass before the native writer changes source.

## Observed public failure and causal evidence

Genuine compiled B addon3658aecf with frozen patch5cd908ac passes same-consumer legal A1/B1/A2/B2, both media plans and nine updates. The first B negative run naturally exits1: fractional maxBitrate resolves with integer readback, overflowing maxBitrate resolves with native signed readback -1, and NaN maxFramerate stops new decoded frames. Frozen consumer db848952 and the first failure remain immutable evidence.

Parent public diagnostic8277bd18 naturally exits0 as a diagnostic: valid25FPS baseline has three complete I420 frames; the same sender accepts NaN and reads it back as a non-finite number; no three subsequent frames arrive within the existing8s consumer deadline; explicitly restoring30FPS and a valid bitrate yields three fresh complete frames on the same peer/MID/ICE. Cleanup reaches native peer/track/sink/timer terminal states naturally. This is causal failure/recovery evidence, not a working-product PASS.

Current typed conversion src/dictionaries/webrtc/rtp_encoding_parameters.cc reads maxBitrate through uint64_t and assigns it to native optional<int>. Its shared uint64 converter casts the double before a comparison against UINT64_MAX, so it cannot safely reject oversized/non-finite doubles. maxFramerate passes through double, while the pinned native value guard only checks negative values. NaN bypasses that guard and the layer-active positive comparison becomes false. We correct only the affected RTP dictionary owner; no global primitive-converter rewrite.

## Minimal authorized source change

Unique native writer may modify only src/dictionaries/webrtc/rtp_encoding_parameters.cc relative to frozen three-file candidate B. Preserve all existing codec/sender/SSRC changes and every other dependency file.

For maxBitrate, change its dictionary parse type and constructor argument from optional<uint64_t> to optional<double>. The existing double parser still requires a JS number, so this does not introduce string coercion. At this dictionary owner, before assigning to the native integer field, require finite, nonnegative and truncated value <= std::numeric_limits<int>::max(). Reject invalid values explicitly through Validation; only then cast to int. Preserve existing legitimate fractional normalization:1234567.5 resolves and reads back1234567. The range check must occur before any unsafe integer cast; checking after uint64 conversion is insufficient. Missing optional fields remain missing and callers' encodings/SSRC are never restored or overwritten.

For maxFramerate, reject non-finite values in this same constructor before writing native parameters. Finite values and existing native negative/range validation remain native-owned; do not clamp rates, silently remove fields, replace NaN with defaults, or change valid fractional semantics. Preserve optional TO projection/readback.

Reuse Validation and standard cmath/limits; no extra numeric parser class, sender-side raw-field guard, global converter changes, patched libwebrtc, dependency/pin updates or JavaScript compensation.

## Public regression and oracle ownership

The old A codec/SSRC round-trip failure rejected every setter; it does not prove that all38 changed inputs individually require rejection. Therefore the blanket allRejected oracle is not binding proof for supported normalization or obsolete ignored fields. The independent native-negative-diagnosis author must finish a per-probe classification with pinned source evidence; Parent adjudicates that frozen table before a consumer writer changes expected outcomes. This document does not declare unreached probes passed.

The final consumer must retain all38 actually changed base inputs, both extra present-SSRC mutations and the one genuinely unavailable optional-channels control. Immutable codec/SSRC/transaction/encoding changes continue to use native rejection. Supported fractional normalization asserts exact normalized readback; existing unsupported ignored fields assert the actual established projection behavior. Every expected outcome retains fresh legal recovery, SSRC stability and three decoded frames; unknown outcomes stay unverified, never rewritten as PASS.

Add real rejection/recovery probes for maxBitrate NaN, infinities, overflow above the native signed boundary and the exact representable boundary; maxFramerate NaN and infinities. Positive fractional bitrate1234567.5 preserves normalization. Each rejecting case leaves parameters unchanged and a fresh get plus legal update resolves with >=3 complete frames. Do not reconstruct a legal recovery from an accepted invalid getter and then mistake its retained invalid value for a valid profile.

Use the same finally/GC drain and natural direct rc as the current valid consumer. A diagnostic may record the offending setter before an after-frame timeout to avoid dropping failure evidence; this is an evidence fix, not a relaxed continuity oracle. Same frozen final consumer must run legal ABAB, classified negatives for both plans, and the existing actual dynamic60FPS source/output bitrate/FPS windows and tolerances. No warmup/tolerance/source-demand relaxation.

## Existing SESE graph and delivery

The project remote-window-binding-experiment.graph.json stays the one three-node experiment graph: admission freezes pins/design/table/consumer -> comparison through the public peer boundary -> Parent settlement with genuine build/provenance and behavior proof. Failure yields explicit unverified/failed and blocks installation; success still needs final installed-daemon/client E2E and implementation review.

Official build inputs/toolchain are already proven in native-b-build-parent/report.md; reuse them without re-investigating SDKs or fake stamps. A new source patch/addon hash requires a new release-input manifest and actual loader proof. The previous3658 addon/manifest is retained as failed-input evidence, never silently relabeled as fixed. Parent owns final build/stage/install using the project's restart channel, loaded server/addon verification, exact candidate/client/device E2E, independent implementation review and joint OTA.
