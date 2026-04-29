# SIMID Signaling — Conclusions & Action Plan

> **One-page summary** of the analysis on why iion's Limelight bid stream doesn't carry SIMID capability signals, and what to do about it. For deeper architectural context, see `KNOWLEDGE-BASE.md` §14, §15, §22a, §22b.

## The problem in one sentence

iion's outbound bid requests omit `imp.video.api` entirely (verified across 3 platform samples — LG webOS, Roku, Fire TV — all missing), so demand partners can't filter for SIMID-capable inventory and iion's own DSP can't route SIMID creatives to the inventory that supports them.

## The 3-leg ad flow

```
Leg 1: Ad request          Leg 2: Bid request        Leg 3: VAST response
Publisher's SDK → SSP      SSP → DSPs                DSP/SSP → Publisher
─────────────────────      ──────────────────        ──────────────────
URL with macros filled:    OpenRTB JSON:             VAST XML body:
  ifa, ip, ua,                "imp.video.api"          the actual ad
  device.os/make              lives HERE
```

`imp.video.api` is built in **Leg 2** by the SSP. Publishers don't fill it directly in URL integrations — the SSP has to populate it from some source.

## The 5 ways the SSP could populate `imp.video.api`

| Source | Status today |
|---|---|
| Publisher SDK declares via S2S OpenRTB | ❌ iion uses URL integration, not S2S |
| Publisher fills `&api=` in URL | ❌ iion's URL spec has no api parameter |
| Limelight per-tag admin UI config | 🟡 Likely exists in Video Ad Unit form (api: [2] in their published example proves it once worked); supply team to verify |
| Limelight infers from `device.os` / `device.make` | ❌ Not currently doing this |
| Limelight infers from `display_manager` | ❌ display_manager comes through empty in samples |

All five inactive today → all 3 sampled bid requests have `api` missing.

## Key findings

1. **OpenRTB defines the vocabulary, not who fills fields.** `api: [8]` = SIMID is a *convention* the spec defines. The spec doesn't make the field appear automatically; somebody on the SSP side has to populate it.

2. **URL macros standardize runtime data, NOT capability declarations.** Standard SDK macros (IFA, IP, UA, app bundle, etc.) cover device runtime context. There's no IAB-blessed `[API_SUPPORTED]` macro; SDKs don't auto-fill capability info via URL templates. Capability declaration was designed into OpenRTB S2S, not URL VAST.

3. **`display_manager` isn't meaningfully easier than `api` at scale.** For URL integrations, both require per-app hardcoding across N codebases × N app store submission cycles. Multi-app publishers won't do it; values go stale on SDK upgrades. `display_manager` is only easy in OpenRTB S2S mode — moving publishers from URL VAST to S2S is months of work, not a shortcut.

4. **Multi-app publishers break per-tag api config.** Verified from iion's own data: **tagid 42191 served BOTH `ben_azelart` (LG webOS) AND `jordan_matter` (Fire TV)** — same publisher 10243, same tag, completely different platforms with different api capabilities. A static per-tag api value is wrong for one of them no matter what you set. Asking publishers for per-app capability surveys (across 5+ platforms × N channels) doesn't complete.

## The only path that scales

**SSP-side platform inference at request time** using `device.os` and `device.make` from each bid request. Both fields are already populated correctly per impression by every publisher's SDK.

```
function inferApi(device) {
  if device.os in {Android, Fire OS} && device.make in {Amazon, Google, TCL, Sony, ...}:
    return [7, 8]   // OMID + SIMID — IMA Android default
  if device.os == "Roku OS":
    return []       // RAF only, no IMA
  if device.os == "tvOS":
    return [7]      // OMID only — Google's IMA tvOS doesn't support SIMID
  if device.os in {webOS TV, Tizen} && chromium_version >= 79:
    return [7, 8]
  return []         // conservative default
}
```

This works because:
- Zero publisher cooperation required
- Same shared tag declares different api per impression based on device fields
- Auto-correct as publisher portfolios grow (new app → device fields work the same)
- No staleness (device fields are real-time)
- Covers ~95% of inventory correctly without any survey or per-app config

## Tactical sequencing for iion

1. **Quick fix (now, zero publisher cooperation)** — ask Limelight engineering to add platform-based `imp.video.api` inference to outbound bid requests. Single config change at SSP level. Unblocks 95% of the problem.

2. **Mid-term (when leveraging publisher relationships)** — layer in `display_manager` from publishers willing to populate it. Accuracy refinement on edge cases (non-standard SDKs, new platforms). Not a prerequisite for step 1.

3. **Long-term (only for premium publishers)** — OpenRTB S2S integration for partners willing to do deeper integration. Unlocks full SDK auto-population including direct api declarations.

Step 1 alone unblocks SIMID inventory signaling. Steps 2 and 3 are accuracy refinements, not blockers.

## Final-form ticket text for Limelight engineering

Copy-paste this into your Limelight support / engineering ticket:

> **Title**: Add platform-based imp.video.api inference to outbound bid requests
>
> **Body**: Limelight's outbound DSP bid requests currently omit `imp.video.api` entirely (verified across 3 platform samples — LG webOS, Roku, Fire TV — all missing). The publisher-facing endpoint is URL-based with no api parameter; SDK auto-population of `api` / `display_manager` doesn't apply to URL VAST mode; per-tag config can't work for portfolio publishers (verified: tagid 42191 already serves both LG webOS and Fire TV apps under publisher 10243).
>
> Add device-based api inference at outbound bid build time:
>
> | device.os × device.make | api array |
> |---|---|
> | {Android, Fire OS} + {Amazon, Google, TCL, Sony, …} | `[7, 8]` |
> | {Roku OS} | `[]` |
> | {tvOS} | `[7]` |
> | {webOS TV, Tizen} + Chromium ≥ 79 | `[7, 8]`; else `[]` |
> | default | `[]` |
>
> Required to unlock SIMID inventory signaling for iion's interactive ad campaigns. This declares api correctly per-impression regardless of how supply tags or publishers are structured.

## Pre-meeting checklist (before escalating to Limelight)

These can each be done by your supply team in <5 minutes; sequence first to avoid sending an engineering ticket if a config-only path exists:

- [ ] **Open Limelight admin UI** → Publisher Manager → an existing Fire TV Tag → Channel → Video Ad Unit → click edit. **Screenshot every field on the form.** Look specifically for: "Supported APIs", "API Frameworks", "Video APIs", "VPAID/SIMID/OMID", or "Display Manager". If present → Scenario A, config-only fix; no engineering ticket needed.

- [ ] **Run the bid stream check** — sample 10K outbound bid requests over 24 hours. Aggregate `imp.video.api` field presence. If ≥99% missing across all platforms, structural gap confirmed; engineering ticket required.

- [ ] **Check `display_manager` field** in the same sample. If empty across all requests, that integration path is also unused.

## Where deeper context lives

| Topic | File / section |
|---|---|
| Full architectural lessons (this analysis expanded) | `docs/KNOWLEDGE-BASE.md` §22b |
| Limelight SSP api gap (original finding) | `docs/KNOWLEDGE-BASE.md` §22a |
| OpenRTB api code reference | `docs/KNOWLEDGE-BASE.md` §15 |
| CSAI vs SSAI insertion model | `docs/KNOWLEDGE-BASE.md` §14 |
| iion's stack + DMP tracker | `docs/KNOWLEDGE-BASE.md` §13 |
| Production integration spec | `docs/PRODUCTION-INTEGRATION.md` |
| Inventory classifier output | `tools/ctv-inventory-classified.csv` |

## Last verified

2026-04-30 — Limelight Public docs at `https://limelight.cloud.xwiki.com/xwiki/bin/view/Public/`, three real bid request samples from iion's bid stream, and one publisher VAST URL endpoint sample.
