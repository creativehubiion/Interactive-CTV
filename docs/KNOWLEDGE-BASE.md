# Interactive CTV SIMID — Knowledge Base

> **Purpose**: durable ground-truth reference for building, serving, and
> debugging SIMID interactive ads on Connected TV (specifically Fire TV via
> IMA Android SDK + ExoPlayer). Captures everything we learned the hard way.
> Read this *before* starting any new SIMID creative work.

---

## 1. What this project is

A **VAST 3.0 ad tag** that wraps an **HTML5 SIMID interactive creative** as
an `<InteractiveCreativeFile>`. Renders on:

- Web (Google IMA HTML5 SDK — the VSI tester at
  `googleads.github.io/googleads-ima-html5/vsi/`)
- **Fire TV / Android TV via Google IMA Android SDK** (≥ 3.20, currently
  3.30.3 in our test bed) hosted in any ExoPlayer-based player app
- iOS via IMA iOS SDK (untested but supported)
- *Not* tvOS — Google's IMA tvOS SDK does not implement SIMID

The creative is a **30-second catch-the-falling-fruit mini-game** with a
D-pad-controlled basket, on-screen debug HUD, and full SIMID lifecycle
wired to iion's DMP tracker. Hosted on GitHub Pages at
`https://creativehubiion.github.io/Interactive-CTV`.

**iion's stack**:
- DSP+SSP: **Limelight** (iion-internal product)
- DMP tracker: `https://staging-dmp-producer.iion.io/tracker/impressions`
  (PLL macros filled server-side at request time)
- Publisher integration: publishers' CTV apps run their own ad SDK
  (typically Google IMA Client-Side); Limelight either operates as the
  publisher's SSP or bids into the publisher's existing SSP via OpenRTB

---

## 2. The bug that took two days

### Symptom
- Linear video plays correctly under IMA on Fire TV.
- IMA's events fire (`loaded`, `impression`, `start`, `adProgress`).
- **No SIMID overlay ever appears.** Iframe is loaded but kept hidden.
- Google's official SIMID sample VAST renders fine on the same device.
- Our isolation-test VAST (our shape + Google's HTML) renders fine.

### Root cause

Our inbound `postMessage` filter required `envelope.protocol` to start
with `"SIMID"`. **IMA never sets a `protocol` field on its envelopes**,
and neither does Google's reference creative. Every message we received
from IMA was silently rejected, including `SIMID:Player:init`. Without
our `resolve` reply to init, IMA keeps the SIMID iframe hidden forever —
that is exactly the spec-defined behavior.

The IAB SIMID 1.1 *spec text* mentions a protocol version, but the
*reference implementation* (`InteractiveAdvertisingBureau/SIMID/examples/simid_protocol.js`)
and Google's compiled production creative both omit a protocol field
from the envelope. **Trust the implementation, not the spec wording.**

### How we found it

By isolation-testing — wrapping Google's working `sample_simid_compiled.html`
inside our VAST tag. That rendered fine on Fire TV → bug was 100% in our
creative HTML/JS. We then disassembled Google's compiled JS and found
their `sendMessage` builds:

```js
var d = {};
d.type      = a;
d.sessionId = this.b;
d.messageId = c;
d.timestamp = Date.now();
// ... args ...
d.args      = b;
this.s.postMessage(JSON.stringify(d), "*");
```

No `protocol` field. We were filtering on a field IMA never sets.

### Fix

Filter inbound by **message type**, not protocol:

```js
const isSimidEnvelope = (envelope) => {
  if (!envelope || typeof envelope.type !== 'string') return false;
  const t = envelope.type;
  return t.indexOf('SIMID:') === 0 || t === 'resolve' || t === 'reject' || t === 'createSession';
};
```

Drop the `protocol` field from outbound envelopes too — match the
reference exactly.

---

## 3. The SIMID 1.1 wire protocol (as IMA actually implements it)

### Envelope shape — every message in both directions

```json
{
  "type":      "SIMID:Player:init",
  "sessionId": "uuid-v4-string",
  "messageId": 12345,
  "timestamp": 1714400000000,
  "args":      { ... }
}
```

Sent as a **JSON-stringified string** via `postMessage(JSON.stringify(env), '*')`.
**No `protocol` field.**

### Message-type namespaces

| Prefix | Direction | Examples |
|---|---|---|
| `SIMID:Player:*` | Player → Creative | `init`, `startCreative`, `adStopped`, `adSkipped`, `fatalError`, `resize`, `appBackgrounded`, `appForegrounded` |
| `SIMID:Creative:*` | Creative → Player | `ready`, `clickThru`, `requestPlay`, `requestPause`, `requestStop`, `requestSkip`, `requestFullscreen`, `requestExitFullscreen`, `requestChangeVolume`, `requestChangeAdDuration`, `requestResize`, `reportTracking`, `getMediaState`, `fatalError`, `log` |
| `SIMID:Media:*` | Player → Creative | `durationchange`, `ended`, `error`, `pause`, `play`, `playing`, `seeked`, `seeking`, `stalled`, `timeupdate`, `volumechange` |
| `createSession` | Creative → Player | Bootstraps session — first message creative sends |
| `resolve` / `reject` | Either → Either | Acks. Args: `{messageId: <original>, value: <reply>}` |

Note: `requestFullscreen` is **lowercase 's'** in the message-type string
even though the spec text mixes casing.

### Lifecycle — exact sequence

```
Creative                                Player (IMA)
   |                                       |
   |---> createSession (bare type)         |
   |     args: {}                          |
   |     sets sessionId on envelope        |
   |                                       |
   |<--- resolve {sessionId acked}         |
   |                                       |
   |<--- SIMID:Player:init                 |
   |     args: {                           |
   |       environmentData: {              |
   |         videoDimensions: {x,y,w,h},   |
   |         creativeDimensions: {x,y,w,h},|
   |         fullscreen: bool,             |
   |         fullscreenAllowed: bool,      |
   |         variableDurationAllowed: bool,|
   |         skippableState: 'adHandles'|  |
   |                          'playerHandles'|'notSkippable',
   |         version: '1.1',               |
   |         muted: bool, volume: number   |
   |       },                              |
   |       creativeData: {                 |
   |         adParameters: '<json string>',|
   |         clickThruUrl: 'https://...'   |
   |       }                               |
   |     }                                 |
   |                                       |
   |---> resolve {messageId of init}       |
   |     ★ THIS is what unhides the iframe |
   |                                       |
   |<--- SIMID:Player:startCreative        |
   |                                       |
   |---> resolve                           |
   |                                       |
   |     ↓ creative renders, user interacts|
   |                                       |
   |<--- SIMID:Media:timeupdate (repeated) |
   |---> SIMID:Creative:reportTracking     |
   |---> SIMID:Creative:requestStop        |
   |                                       |
   |<--- SIMID:Player:adStopped            |
```

### Key spec rules to remember

1. **Iframe is hidden by the player until the creative resolves
   `Player:init`.** Skip the resolve and your overlay never shows. This
   bit us hard.
2. **The creative initiates the session** via `createSession`. The player
   replies with `Player:init`. (Some players will send init even without
   `createSession` — don't rely on that.)
3. **Cross-origin sandboxed iframe.** No DOM access, no shared JS context.
   Communication is *only* postMessage.
4. **The spec is silent on TV remote input.** Creatives listen for
   ordinary DOM `keydown` events. The host WebView delivers D-pad as
   `ArrowUp/Down/Left/Right` and OK as `Enter`.

---

## 4. VAST 3.0 tag shape that works

Mirror Google's `sample_simid_ad.xml` exactly. Verbatim minimum:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VAST xmlns:xsi="https://www.w3.org/2001/XMLSchema-instance"
      xsi:noNamespaceSchemaLocation="vast.xsd" version="3.0">
  <Ad id="...">
    <InLine>
      <AdSystem>your-system</AdSystem>
      <AdTitle>Title</AdTitle>
      <Description>...</Description>
      <Error>https://your.tracker/error</Error>
      <Impression>https://your.tracker/impression</Impression>
      <Creatives>
        <Creative sequence="1">
          <Linear>
            <Duration>00:00:30</Duration>
            <TrackingEvents>
              <Tracking event="start">https://...</Tracking>
              <!-- firstQuartile, midpoint, thirdQuartile, complete, creativeView -->
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough id="x">https://landing.example/</ClickThrough>
            </VideoClicks>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4">
                https://your-cdn/linear.mp4
              </MediaFile>
              <InteractiveCreativeFile type="text/html" apiFramework="SIMID" variableDuration="true">
                https://your-cdn/creative/index.html
              </InteractiveCreativeFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>
```

### What NOT to add

- **No `<![CDATA[...]]>`** wrapping URLs. Bare URLs work; CDATA is
  optional and Google's sample doesn't use it. Some IMA versions can
  parse the CDATA URL with leading whitespace as part of the URL.
- **No extra attributes on `<MediaFile>`** beyond `delivery` and `type`.
  Avoid `width`, `height`, `bitrate`, `id`, `scalable`, `maintainAspectRatio`.
- **No `<AdParameters>`** unless your creative actually parses it. Google's
  sample omits it. Adding it with the wrong namespace can confuse the
  IMA SDK parser.
- **No query strings on the `<InteractiveCreativeFile>` URL.** `?debug=1`
  is fine functionally but adds risk; some implementations split URLs on `?`.
  Make the creative debug-on-by-default and let `?debug=0` turn it off.
- **VAST 4.x is technically supported** but VAST 3.0 is what Google's
  sample uses and what every implementation handles cleanly.

---

## 5. The MediaFile MP4 — CORS is non-negotiable

The HTML5 IMA SDK loads the linear `<video>` with `crossOrigin="anonymous"`.
If your MP4 host doesn't return `Access-Control-Allow-Origin: *` (or matching
origin), the browser blocks playback and IMA falls through to:

```
[Html5VideoDisplay] No valid AdMedia; setting url directly.
AdError 400: There was an error playing the video ad.
```

That's a **CORS** failure, not a bug in your VAST.

### Verified CORS-clean public test MP4s (April 2026)

| URL | Notes |
|---|---|
| `https://storage.googleapis.com/interactive-media-ads/media/android.mp4` | Google's official IMA test bucket. ~6 MB, 1:55 duration, 720p H.264. **Use this.** |
| `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4` | MDN, ~6 sec |

### Verified BROKEN as of 2026

| URL | Status |
|---|---|
| `commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4` | HTTP 403 — Google retired the bucket |
| `download.blender.org/durian/trailer/sintel_trailer-480p.mp4` | HTTP 200 but **no CORS headers** — IMA rejects |
| `storage.googleapis.com/exoplayer-test-media-*` | HTTP 403 |

### How to verify a candidate MP4

```bash
# CORS check
curl -s -I -H "Origin: https://googleads.github.io" "$URL" | grep -iE "access-control"

# OPTIONS preflight (some hosts only respond to OPTIONS)
curl -s -I -X OPTIONS -H "Origin: https://googleads.github.io" \
     -H "Access-Control-Request-Method: GET" "$URL" | grep -iE "access-control"

# Range request (HTML5 video uses byte-range)
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Range: bytes=0-1023" "$URL"
# Expect HTTP 206
```

Either GET-with-Origin or OPTIONS preflight must return
`Access-Control-Allow-Origin: *` (or matching). Range requests must
return HTTP 206.

---

## 6. Hosting the creative

### GitHub Pages works fine

- Repo: `creativehubiion/Interactive-CTV`, branch `main`, served from `/`.
- Public URL: `https://creativehubiion.github.io/Interactive-CTV/...`
- Pages serves `Access-Control-Allow-Origin: *` on creative HTML/JS/CSS.
- HTTPS enforced. HSTS header is set (harmless).
- No `X-Frame-Options` set — iframes are allowed.

### Limitation: tracking pings

GitHub Pages is static. Any `<Tracking>` URLs in the VAST that point at
`/track/...` will return 404. IMA fires the pings regardless; you just
won't see them server-side. For real telemetry, use a Cloudflare Worker /
Vercel Function / etc. as a beacon endpoint and update the VAST.

### Local LAN testing (alternative to Pages)

`server/serve.js` is a plain Node HTTP server that serves the repo +
implements `/track/*` as a 1×1 GIF. Use during dev iteration. Build
the VAST against your LAN IP:

```bash
BASE_URL=http://192.168.x.x:8080 node server/build-vast.js
```

Pair with the "Interactive CTV (SIMID, local LAN)" entry in the demo
app's `media.exolist.json`.

---

## 7. Fire TV testbed — exact recipe

### Hardware / OS
- Fire TV Stick 4K Max (model **AFTMM**), Fire OS 7+
- Amazon WebView **Chromium 118.0.5993.155** (modern enough; supports
  ES2020+, optional chaining, nullish coalescing, etc.)

### Host app
- `C:\Users\BAUHAU5\ExoPlayer\` — legacy `google/ExoPlayer` 2.19.1 (last
  release before AndroidX Media3 migration)
- IMA SDK pinned at `com.google.ads.interactivemedia.v3:interactivemedia:3.30.3`
  in `extensions/ima/build.gradle`. **Supports SIMID 1.0**, which has the
  same wire format as 1.1 for the messages we use.
- Demo app package: `com.google.android.exoplayer2.demo`
- Run config: `demo`, build variant `noDecoderExtensionsDebug`

### Android Studio gotchas (lessons learned)

- **Gradle JDK**: Studio 2023.2 moved the bundled JDK from `jre/` to
  `jbr-17/`. If `local.properties` or the IDE's Gradle setting points at
  the old `jre/` path, you get `JavaHomeException` and sync fails in
  100ms. Fix: **Settings → Build, Execution, Deployment → Build Tools →
  Gradle → Gradle JDK = jbr-17 JetBrains Runtime 17.0.9** (path
  `C:\Program Files\Android\Android Studio\jbr`).
- **Stale Gradle daemons** keep the old JavaHome cached. Even after
  fixing the IDE setting, sync still fails. Fix: delete `~/.gradle/daemon/*`.
- **Two adb binaries** (standalone `C:\Android\adb.exe` from 2014 and
  Android Studio's SDK platform-tools adb) **fight each other** —
  starting/killing each other's servers in a loop. Use
  `C:\Users\BAUHAU5\AppData\Local\Android\Sdk\platform-tools\adb.exe`
  exclusively. Either delete the standalone or prepend SDK platform-tools
  to PATH.

### Sideload + run — exact PowerShell

```powershell
$adb = "C:\Users\BAUHAU5\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$d   = "192.168.0.124:5555"

& $adb kill-server
& $adb start-server
& $adb connect $d
& $adb devices                   # expect "192.168.0.124:5555  device"
```

Then in Android Studio: ▶ Run on `demo`. The APK installs to the Fire
Stick and launches.

### Or skip the rebuild — push a VAST URL via Intent extra

```powershell
& $adb -s $d shell am start -n com.google.android.exoplayer2.demo/.PlayerActivity `
  -a android.intent.action.VIEW `
  -d "https://storage.googleapis.com/interactive-media-ads/media/android.mp4" `
  --es ad_tag_uri "https://creativehubiion.github.io/Interactive-CTV/vast/interactive-vast.xml"
```

This launches `PlayerActivity` directly with our VAST attached — no
rebuild needed. The picker entry in `media.exolist.json` is convenient
but not required for testing.

---

## 8. Debugging — what worked and what didn't

| Tool | Verdict | Notes |
|---|---|---|
| **Google IMA HTML5 VSI tester** (`googleads.github.io/googleads-ima-html5/vsi/`) | ✅ Best first step | Real IMA SDK, fast iteration, full DevTools available. Renders SIMID overlays. |
| **adb logcat** with broad filter | ✅ Useful for IMA-internal errors | Use `*:I 2>&1 \| Select-String "ima\|simid\|adsmanager\|webview\|chromium\|console"`. The IMASDK tag is where SDK warnings appear. |
| **chrome://inspect → device** | 🟡 Marginal | Fire TV reports "Device is locked" intermittently even when it's not. Page IDs go stale fast. |
| **Direct devtools port forward** (`localabstract:webview_devtools_remote_<PID>`) | 🟡 Works but PID changes | The socket is named with the PID suffix. Find via `cat /proc/net/unix \| grep devtools`. Useful for inspecting the IMA bridge WebView. |
| **DevTools attached to IMA bridge WebView** | 🟡 Brief window | The WebView lives only while an ad is playing. Once the ad ends, the page ID dies. Pause the ad to keep it alive — but on Fire TV pause sometimes still tears it down. |
| **Standalone test host** (`test/simid-test-host.html`) | ✅ Best for non-IMA verification | Open in any browser; loads our creative in an iframe and runs a minimal SIMID player. Confirms creative renders + protocol handshake works without IMA in the picture. |
| **Isolation-test VAST** (our shape + Google's HTML) | ✅ Killer bisection tool | If Google's HTML renders via our VAST but our HTML doesn't, the bug is provably in our HTML. |

### When all else fails

Disassemble Google's `sample_simid_compiled.html`. It's minified but the
SIMID-related strings are intact and you can recover the message-sending
structure. That's literally how we found the actual bug.

```bash
curl -s "https://storage.googleapis.com/interactive-media-ads/ad-tags/simid_assets/sample_simid_compiled.html" > /tmp/g.html

# Find every SIMID message type
grep -oE '"SIMID:[^"]+"' /tmp/g.html | sort -u

# Find sendMessage definition
grep -A 5 "sendMessage=function" /tmp/g.html
```

---

## 9. Bug catalog — every issue we hit on this project

### #1 — Dead MediaFile URLs

**Symptom**: `AdError 400: There was an error playing the video ad`.
The linear video never plays.

**Cause**: `commondatastorage.googleapis.com/gtv-videos-bucket/...` —
the canonical "Big Buck Bunny" test bucket — started returning HTTP 403
sometime in 2024-2026 across every URL on that path. Many published VAST
samples in the wild are dead.

**Fix**: switch to `storage.googleapis.com/interactive-media-ads/media/android.mp4`
(Google's IMA test bucket).

### #2 — Missing CORS on the MediaFile

**Symptom**: console spam `[Html5VideoDisplay] No valid AdMedia; setting
url directly`. Linear ad either fails or plays muted/glitchy. AdError 400.

**Cause**: MP4 host doesn't send `Access-Control-Allow-Origin`. Browser
blocks crossOrigin video playback.

**Fix**: use a CORS-clean MP4 (see §5).

### #3 — Wrong VAST shape

**Symptom**: linear plays but no SIMID overlay; `<InteractiveCreativeFile>`
silently ignored.

**Suspects** (we never definitively isolated which mattered most):
- VAST 4.2 instead of 3.0
- CDATA wrapping URLs
- Extra MediaFile attributes
- Query string on the SIMID URL
- `<AdParameters>` block

**Fix**: mirror Google's `sample_simid_ad.xml` exactly. VAST 3.0, no
CDATA, only `delivery` and `type` on `<MediaFile>`, no `<AdParameters>`,
clean URL on `<InteractiveCreativeFile>`.

### #4 — Cross-origin postMessage monkey-patch (SecurityError)

**Symptom**: HUD initialization failed silently. Logging looked broken.

**Cause**: `hud.js` did `window.parent.postMessage = function(...)` to
intercept outbound traffic. Cross-origin sandboxed iframes (which is
exactly what SIMID creatives are) **cannot reassign properties on the
parent window** — that throws `SecurityError`, which aborts the IIFE.

**Fix**: don't monkey-patch the parent. Provide `HUD.logOutbound()`
explicitly and have `simid-protocol.js` call it before sending.

### #5 — Wrong message type strings

**Symptom**: handshake never completes; iframe stays hidden.

**Cause**: our code used bare `'Player:init'` etc. The actual wire
format uses `'SIMID:Player:init'` — the prefix is part of the type
string itself.

**Fix**: prefix every type with `SIMID:`, except the bootstrap
`createSession` and ack `resolve`/`reject`.

### #6 — Inbound filter required `protocol` field IMA never sets

**Symptom**: same as #5 — handshake never completes; iframe hidden.

**Cause**: our filter was
`envelope.protocol.indexOf('SIMID') === 0`. IMA's envelopes don't have a
`protocol` field. Every Player:* message was silently dropped.

**Fix**: filter by `envelope.type` instead. **This was the actual bug
that kept our overlay hidden for two days even after #5 was fixed.**

### #7 — Late script load → missed early messages

**Risk** (mitigated, may not have been a real bug): if IMA sends
`Player:init` before our 3 external scripts finish loading on a slow
WebView, we miss the message and never resolve.

**Fix**: inline early-bird buffer in `<head>` captures every
postMessage before the protocol module is parsed; replays them through
the normal handler once it's ready.

### #8 — Fire TV adb chaos

- `adb` v1.0.32 (2014) standalone vs v1.0.41 (current SDK) fight each other.
- Fire TV `dumpsys` reports "device locked" even when it's not, breaking
  `chrome://inspect`.
- WebView debug socket includes the PID suffix: `webview_devtools_remote_<PID>`.

**Fixes**: see §7.

---

## 10. Project file map

```
G:\Claude Code\Projects\Interactive CTV\
├── creative\                                Production HTML5 SIMID creative
│   ├── index.html                           Entry, includes early-bird message buffer
│   ├── styles.css                           TV-safe layout, big focus rings
│   ├── simid-protocol.js                    Minimal SIMID 1.1 creative-side wrapper
│   ├── app.js                               D-pad selector, watchdog, lifecycle
│   └── hud.js                               On-screen debug HUD (default ON)
├── vast\
│   ├── interactive-vast.template.xml        Source template (uses ${BASE_URL})
│   ├── interactive-vast.xml                 Built artifact deployed to Pages
│   └── interactive-vast-google-creative.xml Isolation-test variant
├── server\
│   ├── serve.js                             Plain-Node static + /track/* server
│   ├── build-vast.js                        Substitutes ${BASE_URL} into template
│   └── package.json
├── test\
│   └── simid-test-host.html                 Standalone SIMID player for direct creative testing
├── docs\
│   └── KNOWLEDGE-BASE.md                    This file
├── README.md                                Setup + test recipe
└── .gitignore
```

### Live URLs

| Asset | URL |
|---|---|
| Repo | `https://github.com/creativehubiion/Interactive-CTV` |
| **VAST tag (production)** | `https://creativehubiion.github.io/Interactive-CTV/vast/interactive-vast.xml` |
| Isolation-test VAST | `https://creativehubiion.github.io/Interactive-CTV/vast/interactive-vast-google-creative.xml` |
| Standalone test host | `https://creativehubiion.github.io/Interactive-CTV/test/simid-test-host.html` |
| Creative (direct) | `https://creativehubiion.github.io/Interactive-CTV/creative/index.html` |

---

## 11. Reference links

### Specifications & Google's reference
- [IAB SIMID 1.1 spec](https://interactiveadvertisingbureau.github.io/SIMID/)
- [IAB SIMID GitHub repo](https://github.com/InteractiveAdvertisingBureau/SIMID)
- [Reference protocol implementation](https://github.com/InteractiveAdvertisingBureau/SIMID/blob/master/examples/simid_protocol.js) — but *also* check Google's compiled production creative below since the spec and the implementation diverge in subtle ways
- **Google's working SIMID sample creative** (this is ground truth): `https://storage.googleapis.com/interactive-media-ads/ad-tags/simid_assets/sample_simid_compiled.html`
- **Google's SIMID sample VAST**: `https://storage.googleapis.com/interactive-media-ads/ad-tags/sample_simid_ad.xml`
- [Google IMA Android compatibility table](https://developers.google.com/interactive-media-ads/docs/sdks/android/client-side/compatibility) — confirms which SDK versions support SIMID
- [Google Ads Developer Blog — SIMID in IMA, May 2020](https://ads-developers.googleblog.com/2020/05/simid-support-in-interactive-media-ads.html)

### Test tools
- [Google IMA HTML5 VSI tester](https://googleads.github.io/googleads-ima-html5/vsi/)
- [Google IMA HTML5 SDK samples on GitHub](https://github.com/googleads/googleads-ima-html5)
- [googleads-ima-android samples](https://github.com/googleads/googleads-ima-android)

### Fire TV / WebView
- [Amazon Fire TV controller input mapping](https://developer.amazon.com/docs/fire-tv/remote-input.html)
- [Amazon Fire TV web app best practices](https://developer.amazon.com/docs/fire-tv/web-app-best-practices.html)
- [Amazon WebView Chromium info](https://developer.amazon.com/docs/fire-tv/web-app-development-resources.html)

### Other
- [IAB VAST CTV Addendum 2024](https://iabtechlab.com/wp-content/uploads/2024/07/VAST-CTV-Addendum-2024-FINAL.pdf)
- [AWS MediaTailor SIMID handling](https://docs.aws.amazon.com/mediatailor/latest/ug/ad-reporting-client-side-ad-tracking-schema-player-controls-simid-ads.html)

---

## 12. Building a new SIMID creative — checklist

Use this whenever you start a new variant.

### VAST

- [ ] VAST 3.0 (`version="3.0"`)
- [ ] No CDATA on URLs
- [ ] `<MediaFile>` has only `delivery="progressive"` and `type="video/mp4"`
- [ ] MediaFile MP4 verified CORS-clean (see §5)
- [ ] `<InteractiveCreativeFile type="text/html" apiFramework="SIMID" variableDuration="true">`
- [ ] No query string on the SIMID URL
- [ ] No `<AdParameters>` unless your creative reads `creativeData.adParameters`
- [ ] Tracking pings use a real beacon endpoint or you accept they'll 404 on Pages

### Creative HTML

- [ ] Early-bird message buffer in `<head>` (script tag inline, before any external `<script>`)
- [ ] CSS sets `html, body { background: transparent }` so the iframe doesn't blank out the linear video
- [ ] Stage element uses `position: fixed; inset: 0` and `display: none` until activated
- [ ] All focusable UI elements have `tabindex="0"` and visible focus rings (4 px+ outline)
- [ ] D-pad navigation: keydown listener handles `ArrowUp/Down/Left/Right` + `Enter`
- [ ] Skip handling: keydown listener handles `Escape`/`Backspace` (Fire TV may swallow Back)
- [ ] Watchdog timer for inactivity → `requestSkip` + teardown

### SIMID protocol

- [ ] Envelope shape: `{type, sessionId, messageId, timestamp, args}` — **no `protocol` field**
- [ ] Inbound filter: by `envelope.type` (`SIMID:*` or `resolve`/`reject`/`createSession`)
- [ ] Outbound: JSON.stringify before postMessage
- [ ] At startup: send `createSession` with a UUID sessionId
- [ ] On `SIMID:Player:init`: reply with `resolve` (with messageId of the original init). **This is what un-hides the iframe.**
- [ ] On `SIMID:Player:startCreative`: reply with resolve, then show your UI
- [ ] On user dismissal: send `SIMID:Creative:requestStop`
- [ ] On selection / engagement: send `SIMID:Creative:reportTracking` with `{eventName, params}`

### Verification

- [ ] Open creative URL directly in Chrome — should render with HUD visible
- [ ] Open `test/simid-test-host.html` URL — should render overlay over linear video, log shows full handshake
- [ ] Paste VAST URL into Google IMA HTML5 VSI tester — should render SIMID overlay over `android.mp4`
- [ ] Sideload demo on Fire TV, pick the entry — should render overlay, D-pad should move focus

If step 4 fails but step 3 passes, the bug is IMA-Android specific —
disassemble Google's compiled creative and diff against ours.

---

*Last verified working: 2026-04-29 with IMA Android SDK 3.30.3 on Fire TV
Stick 4K Max (AFTMM) running Fire OS 7+ / Amazon WebView Chromium 118.*

---

## 13. iion-specific integration

### Stack

| Component | Detail |
|---|---|
| DSP + SSP | **Limelight** (iion-internal product) |
| DMP tracker | `https://staging-dmp-producer.iion.io/tracker/impressions` |
| Demand sources | Direct + demand partners, brought in via Limelight |
| Publisher integration | Either Limelight as the publisher's SSP, or Limelight bidding into another SSP via OpenRTB |
| GitHub repo | `creativehubiion/Interactive-CTV` (public; see §16 for privacy options) |

### iion's PLL macro list

The standard tracker URL on iion campaigns uses these macros, replaced
server-side at request time:

```
%%campaignId%%      → campaign_id
%%pubId%%           → publisher_id
%%creativeId%%      → creative_id
%%requestId%%       → request_id
%%userId%%          → user_id
%%ip%%              → ip_address
%%bundle%%          → app_id_bundle_id
%%ifa%%             → maid (mobile ad id)
%%appName%%         → app_name
%%os%%              → os
%%userAgentEnc%%    → user_agent (URL-encoded)
%%lat%% / %%lon%%   → latitude / longitude
%%pageUrl%%         → page_url
%%country%%         → country
%%deviceMake%%      → device_make
%%domain%%          → domain
%%height%% %%width%% → dimensions
%%videoMinDuration%% / %%videoMaxDuration%%
%%contgenre%% %%contcat%%   → content metadata
%%gdpr%% %%gdprConsent%%    → privacy
%%demandId%%        → demand_id
%%adgroupId%%       → line_item
```

The creative **never** hardcodes these or fills them in itself. They
flow through the URL pre-replaced by the SSP, and the creative just
appends `&event_name=…` and event-specific runtime data.

See `docs/PRODUCTION-INTEGRATION.md` for the full AdParameters wire
format + funnel SQL queries.

---

## 14. CSAI vs SSAI — critical filter for "where does SIMID actually work"

**SIMID requires Client-Side Ad Insertion (CSAI).** Server-side stitched
ads (SSAI / DAI) bake the linear into the content stream and break SIMID
rendering completely — there's no client-side IMA SDK running for the ad
break, no separate ad layer to overlay an iframe on, and no input
plumbing.

### IMA has TWO SDK products — easy to confuse

| Product | Insertion model | SIMID? |
|---|---|---|
| **IMA Client-Side SDK** (`AdsLoader` + `AdsManager`) | CSAI | ✅ |
| **IMA DAI SDK** (`StreamRequest` + `StreamManager`) | SSAI | ❌ |

Both are "IMA SDK" colloquially. **Only the Client-Side one renders
SIMID.** When verifying a publisher's stack, ask whether they use
`AdsManager` (CSAI) or `StreamManager` (DAI).

### Real-world heuristics

| Publisher type | Likely insertion | SIMID? |
|---|---|---|
| Premium VOD apps with own engineering teams | CSAI | ✅ if IMA CS |
| Custom Fire TV publisher apps (catalog VOD) | CSAI | ✅ |
| FAST channel via WURL / Wurl-Roku | **SSAI** | ❌ |
| Samsung TV Plus / LG Channels / Xumo | **SSAI** | ❌ |
| Pluto TV, Tubi | SSAI | ❌ |
| Smart TV native ad inventory | Mixed | ⚠️ verify |

### IMA SDK variant matrix

| IMA SDK | Platforms | SIMID 1.0 |
|---|---|---|
| IMA HTML5 (Web) | Tizen, webOS, SmartCast, Vidaa, in-browser | ✅ |
| IMA Android | Android TV, Google TV, Fire TV | ✅ |
| IMA iOS | iOS, iPadOS (mobile, not CTV) | ✅ |
| IMA tvOS | Apple TV | ❌ — explicitly excluded |
| IMA Cast | (deprecated) | — |

Roku has no IMA SDK at all — uses Roku Ad Framework (RAF) +
proprietary BrightLine/Innovid runtimes for interactive.

---

## 15. OpenRTB SIMID signal — the cleanest "is this inventory SIMID-capable" check

OpenRTB 2.6 `Video` object includes:

```json
"imp": [{
  "video": {
    "protocols": [3, 5, 6, 7, 8],   // VAST 2.0/3.0/3.0wrapper/4.0/4.0wrapper
    "api":       [7, 8]              // 7 = OMID, 8 = SIMID
  }
}]
```

**API code 8 = SIMID 1.0 support declared by the publisher's player.**

For Limelight's bid stream:

```sql
SELECT app_bundle, device_os,
       COUNT(*) AS total_requests,
       SUM(CASE WHEN '8' = ANY(string_to_array(imp_video_api, ',')) THEN 1 ELSE 0 END) AS simid_capable
FROM bid_requests
WHERE date >= NOW() - INTERVAL '7 days'
GROUP BY app_bundle, device_os
ORDER BY total_requests DESC;
```

This is the **cheapest, highest-fidelity** signal of SIMID-renderable
inventory. Beats scraping app store listings (Amazon serves CAPTCHA
walls; Vizio/Vewd/Vidaa internal IDs aren't on Play Store).

**Production strategy**: dual-creative campaigns. Bid SIMID where
`api: [8]` is declared; bid plain VAST linear elsewhere. Same audience
targeting, two creative variants delivered conditionally.

---

## 16. Hosting + privacy: Pages doesn't work on private free repos

**Important**: GitHub Pages on a free GitHub plan only serves from
**public** repos. Flipping `creativehubiion/Interactive-CTV` private
breaks the VAST URL and IMA returns `AdError 1005: Failed to fetch`.

### Three paths

| Option | Cost | Notes |
|---|---|---|
| GitHub Pro | $4/mo | Enables Pages on private repos. Same URLs keep working. Cheapest, no migration. |
| **Cloudflare Pages** | **Free** | Connects to private GitHub repo, serves publicly at `<project>.pages.dev`. Free for commercial use. Faster CDN + cache purge API. **Recommended for iion.** |
| Vercel | Free for personal, **$20/mo for commercial** | Hobby tier explicitly forbids commercial use. Cloudflare wins on price. |

### Cache-bust workflow on GitHub Pages (current setup)

GH Pages serves `Cache-Control: max-age=600`. Layers between push and
Fire TV:

```
git push (instant)
  → GH build pipeline (30 s – 2 min)
  → Fastly CDN (30 s – 2 min)
  → Fire TV WebView resource cache (max-age=600)
  → IMA SDK in-memory HTML cache (per session)
```

**Force-fresh on every code change**:
1. Bump `?v=N` on script tags in `index.html` AND on the
   InteractiveCreativeFile URL in the VAST template.
2. Wait for the deploy poll to confirm GH Pages serves the new version.
3. Force-stop the demo on Fire TV:
   ```
   adb shell am force-stop com.google.android.exoplayer2.demo
   ```
4. Relaunch the ad.

Cloudflare Pages would eliminate this dance via instant cache purge.

---

## 17. IMA Android SDK 3.30.3 specific quirks (the testbed)

These three behaviors of IMA Android 3.30.3 informed creative design:

### Use `requestSkip`, NEVER `requestStop`

`SIMID:Creative:requestStop` is interpreted by IMA Android 3.30.3 as
"creative crashed, retry from top" → reloads iframe + replays linear.
Use `requestSkip` for user-initiated dismissal. Google's reference
compiled creative also only uses `requestSkip`.

### Linear audio is uncontrollable from inside the iframe

`Creative:requestPause` doesn't reliably stop linear audio.
`Creative:requestChangeVolume(0, muted=true)` is also ignored.
Multi-stage retries (0ms, 250ms, 1s) didn't help.

**Production fix**: serve a **silent linear MediaFile** (re-encoded with
no audio track). Then it doesn't matter what IMA does with audio
control — there's no audio to mute.

### `<AdParameters>` requires re-testing per VAST shape

Including `<AdParameters>` in VAST 4.2 + namespaced + CDATA-wrapped form
broke SIMID rendering on this build (linear played, overlay didn't
appear). Removing it restored SIMID. Untested in our current VAST 3.0 +
plain CDATA shape.

If AdParameters stays broken, fall back to passing the tracker URL via
`?tracker=…` query string on the InteractiveCreativeFile URL.

---

## 18. Game-init timing — when to call game.start()

**Rule**: when the creative includes a game/UI that depends on measured
layout dimensions, gate `game.start()` on `Player:startCreative` (with a
2-second auto-start fallback), AND re-measure each frame inside the
game loop.

**Why**: IMA keeps the SIMID iframe `display:none` until init resolves.
If the game runs `getBoundingClientRect()` during DOMContentLoaded, the
field returns 0×0 → game boots with `fieldW=0` → basket clamps, items
spawn off-screen, **timer keeps counting but everything appears frozen**.

The Google reference creative pattern (`new SimidSurvey().startCreative()`
on page load) only works because their UI uses fixed positions, no
measurements.

In `app.js`:
```js
simid.addEventListener('start', onStart);
setTimeout(() => { if (!started) onStart(); }, 2000);

function onStart() {
  showStage();
  requestAnimationFrame(() => game.start());
}
```

In `game.js _loop`:
```js
const rect = this.fieldEl.getBoundingClientRect();
if (rect.width > 50 && rect.width !== this.fieldW) {
  this.fieldW = rect.width;
  if (oldW === 0) this.playerX = this.fieldW / 2;
}
```

Belt-and-braces. Confirmed twice during dev that unconditional-on-DOMContentLoaded
boot breaks the game on Fire TV.

---

## 19. Fire TV WebView (Amazon Chromium 118) gotchas

Amazon forks Chromium for its WebView. Confirmed quirks:

1. **`contain: paint`** clips absolute children (rendering bug). Don't use it.
2. **CSS transforms on `<svg>` root elements** sometimes render the SVG
   as a "broken image placeholder" icon. Wrap SVGs in a `<div>` and
   transform the div, or use CSS-drawn shapes when possible.
3. **`filter: drop-shadow()`** is GPU-expensive — drops frames at scale.
   Use `text-shadow` instead.
4. **CSS `transition: transform Xms`** fights with RAF transform updates
   and causes micro-stutter on continuously-moving game elements.
   Pick one — don't combine.
5. **Bundled emoji font caps at Emoji 9.0** (~2016). 🧺 (Emoji 11.0),
   🪨 (13.0) render as tofu. Stick to Emoji 1.0–3.0 era glyphs OR use
   CSS-drawn shapes.
6. **WebView debug socket** is named `webview_devtools_remote_<PID>` —
   the PID changes per launch. `chrome://inspect/#devices` may not
   discover it; manually forward via `adb forward tcp:9222
   localabstract:webview_devtools_remote_<PID>` and hit
   `localhost:9222/json/list`.
7. **`chrome://inspect` "Device is locked"** is a Fire OS false positive
   (`mShowingLockscreen=true` is reported in normal states). Use direct
   port forward to bypass.
8. **First-gen Fire Sticks** ship older WebView; don't ship ES2020+
   syntax (optional chaining, nullish coalescing) without transpiling.

### Performance budget

- DOM ≤ 500 nodes
- `transform: translate3d(...)` + `will-change: transform` for moving
  elements
- Avoid `box-shadow: blur` and `filter: blur`
- Cap simultaneous animated children to ~10
- Pre-decode static images (in initial DOM)

---

## 20. CTV inventory classification — `tools/classify-inventory.js`

The repo includes a re-runnable classifier for CTV inventory files:

```bash
node tools/classify-inventory.js path/to/inventory.txt out.csv
```

Takes a `pdftotext -layout` extraction of an inventory file and outputs:
- Per-row verdict (`yes`/`maybe`/`unlikely`/`no`)
- Per-platform aggregated stats
- Live app-ads.txt probes for major CTV publisher domains

### Per-platform SIMID baseline encoded in the classifier

| Platform | Baseline | IMA SDK | Why |
|---|---|---|---|
| Fire TV | yes | Android | IMA Android supports SIMID 1.0 |
| Android / Android TV / Google TV | yes | Android | Same |
| Roku | no | none | RAF, not SIMID |
| TCL | maybe | split | Both Roku TV + Google TV variants ship under TCL |
| Samsung CTV / Samsung | maybe | HTML5 | Tizen web-based; SIMID if IMA HTML5; mostly Samsung Ads |
| LG | maybe | HTML5 | webOS, same |
| Vizio | maybe | HTML5 | SmartCast |
| Vidaa | maybe | HTML5 | Hisense Vidaa OS |
| Vewd | maybe | HTML5 | Vewd Smart TV browser |
| Comcast / Cox / Rogers / Videotron | unlikely | unknown | Cable STB, usually SSAI |
| Xumo | unlikely | mixed | FAST = SSAI |
| Tubi | unlikely | unknown | Fox-owned, own SDK |

### Heuristic adjustments per row

- App name matches `/24[\s-]?hour|news\s*now|\d+news|channel|network|tv|live/i`
  → downgrade by one step
- `publisher_source = WURL` → downgrade by one step (Roku-owned FAST
  distribution)

### Live probe results (April 2026, in `tools/ctv-inventory-classified-probes.json`)

- **Pluto TV**: 19× google + 50× FreeWheel + 7× SpringServe → IMA but mixed SSAI
- **Tubi**: 0 google → confirms own ad stack
- **Samsung**: 14× google + 26× FreeWheel → cleanest IMA signal
- **TCL**: 63× google + 105× FreeWheel + 9× SpringServe → mixed
- **Vizio**: 17× google + 175× FreeWheel + 8× SpringServe → mixed
- **Vidaa**: 27× google + 85× FreeWheel + 5× SpringServe → mixed
- **Roku**: 6× google + 22× FreeWheel + 1× SpringServe → mostly RAF
- **Xumo**: 15× google + 122× FreeWheel + 2× SpringServe → SSAI heavy
- **Comcast**: 3× google + 32× FreeWheel + 1× Truex → confirms Truex as their interactive

### Headline rollup on the supplied 9,425-row gaming-adjacent CTV inventory

| Verdict | % | Occurrences | What it means |
|---|---|---|---|
| ✅ yes | 10.1% | 481 | Fire TV + Android TV — definite SIMID |
| ⚠️ maybe | 57.9% | 2,750 | Smart TV (Samsung/LG/Vizio/Vidaa/TCL) — depends on IMA HTML5 usage |
| ❌ unlikely | 14.9% | 708 | FAST + STB — server-stitched |
| 🚫 no | 17.0% | 807 | Roku — RAF, no SIMID at all |

### What doesn't work for per-app live data

- Amazon ASIN scraping → CAPTCHA wall on every request
- Play Store lookup of vendor-internal IDs (com.vizio.X) → these aren't
  real Play Store packages, return 404

For per-app data at scale, options are: (a) a paid commercial service
(Pixalate / DoubleVerify / IAS), (b) an OpenRTB bid-stream signal
analysis (see §15 — best free path), or (c) a render-confirmed beacon
from the SIMID creative itself logged through the DMP funnel
(`docs/PRODUCTION-INTEGRATION.md`).

---

## 21. Fruit-catch creative — current build

30-second native-DOM mini-game inside the SIMID shell. Pure DOM, no
canvas, no Phaser — runs cheaply on entry-level Fire Sticks.

### Files

| File | Role |
|---|---|
| `index.html` | DOM scaffold + early-bird postMessage buffer in `<head>` |
| `styles.css` | TV-safe layout 1920×1080, CSS-drawn basket, debug HUD |
| `simid-protocol.js` | SIMID 1.1 — type-based filter, no `protocol` field |
| `tracker.js` | iion DMP tracker integration (events appended to URL from AdParameters) |
| `game.js` | Fruit-catch logic + Web Audio synthesized SFX |
| `app.js` | Lifecycle orchestration, exit guardrails, input routing |
| `hud.js` | On-screen debug HUD (default ON; `?debug=0` to suppress) |

### Tunables (top of `game.js`)

```js
const ROUND_MS  = 30_000;
const SPAWN_MIN_MS = 850;
const SPAWN_MAX_MS = 1500;
const FALL_MIN_PX_PER_S = 180;
const FALL_MAX_PX_PER_S = 290;
const PLAYER_SPEED_PX_PER_S = 900;
const GOOD_ITEMS = ['🍎','🍓','🍇','🍌','🥝','🍑','🍊'];   // Emoji 1.0–3.0 only
const BAD_ITEMS  = ['💣'];                                  // 🪨 dropped — Fire OS 7 doesn't have Emoji 13.0
const BAD_PROB   = 0.18;
```

### Exit guardrails (top of `app.js`)

- `INACTIVITY_MS = 60_000` — auto-skip after 60s no input
- `HARD_CAP_MS   = 180_000` — force-exit at 180s

### Input

| Key | Action |
|---|---|
| Left / Right | Move basket (continuous hold-to-move) |
| Up | Pull focus to Skip button |
| Down (when Skip focused) | Return focus to game |
| OK on Skip | Confirm skip |
| Back / Escape | Instant skip |

**Caveat**: Up/Down for Skip conflicts with games that need 4-way input.
For future games requiring all directions, switch to **Pattern C**:
modal-on-long-press exit menu (long-press OK or Back for 1.5 s opens a
Skip dialog; all D-pad keys go to game by default).

### Sounds (Web Audio synthesized, no external assets)

- Round start: ascending arpeggio
- Catch fruit: rising triangle blip
- Catch bomb: descending square buzz
- Last 3 seconds: tick beep on each second
- Round end: descending fanfare

AudioContext is unlocked on first remote keypress (some Fire TV WebView
builds keep contexts suspended).

---

## 22a. Limelight SSP — bid request schema doesn't declare SIMID

Confirmed via Limelight's public documentation at
`limelight.cloud.xwiki.com/xwiki/bin/view/Public/Client%20Documentation/2.%20Frequently%20asked%20questions/Bid%20response%20examples/`

**Their documented bid request `video` schema only includes VPAID api codes**:

```json
// Limelight's published examples
"video": {
  "protocols": [2, 3, 5, 6],   // VAST 2.0/3.0 + wrappers (their docs)
  "api":       [1, 2]           // VPAID 1.0 + 2.0 ONLY — no OMID, no SIMID
}
```

**Live bid requests sampled from production confirm**:

```json
"video": {
  "protocols": [1,2,3,7,4,5,6,8],   // VAST 4.x wrappers ARE forwarded
  // api: completely missing
}
```

So Limelight upgraded VAST protocol support at some point but **never
added the corresponding API codes for OMID (7) or SIMID (8)** to their
bid request template. The `api` field is silently omitted from outbound
DSP bid requests, even for inventory where the publisher's player
declares SIMID support.

### What this means

- **Demand partners can't filter SIMID-capable inventory** via bid stream — no `api: [8]` signal anywhere
- **iion's own DSP-side filtering** can't use `api` either — must fall back to platform-based inference (`device.os ∈ {Android, Fire OS}`)
- **This is an SSP integration gap**, not a per-publisher configuration issue
- **Verified by**: two live bid requests from different platforms (LG webOS + Roku); both had no `api` field despite different publisher integrations

### Two paths forward

**Option 1 — fix Limelight (proper)**: file an internal feature request
to add `api: [7, 8]` to outbound bid requests via either:
- Per-publisher capability config (publisher declares in onboarding)
- Platform-based inference at the SSP layer (Fire TV / Android TV →
  default to `api: [7, 8]`)

### Deeper root cause: it's a publisher-integration gap, not just a schema gap

Verified by inspecting a Fire TV bid request (Fire OS 6.0, AFTMM,
Chromium 118) — even VPAID api codes are missing, not just SIMID. Why?

**Limelight's publisher-facing endpoint is a VAST URL**:
`https://ads-2479v.iionads.com/vastm/<tagid>?w=...&h=...&ifa=...&...`

**A VAST URL has no parameter for the publisher's player to declare
which api frameworks it supports.** So even if Limelight fixed their
outbound bid request to include `api`, they'd have no data to put there.

This decomposes the problem into two independent fixes:

| Fix | Layer | Effort |
|---|---|---|
| Add `&api=7,8` URL param to Limelight's VAST endpoint convention | Publisher → SSP | Spec + IMA SDK config update; backwards-compatible |
| Add `api` to outbound DSP bid request | SSP → DSP | Already in their schema, just needs to be populated |
| Shortcut both via platform inference at SSP layer | SSP-internal | One config change: `if device.os ∈ {Android, Fire OS}: api = [7,8]` |

The shortcut (platform inference) is the practical answer because:
- IMA Android is dominant on Fire TV / Android TV — declaring `[7, 8]` is correct ~95%+ of the time
- No publisher integration changes needed
- Fixes the bid-stream signal for demand partners immediately

### Why even VPAID is missing on Fire TV impressions

IMA Android **does not support VPAID at all** — VPAID is HTML5/web-only
in Google's IMA SDK family. So a Fire TV publisher correctly declares
"no VPAID". But the absence of OMID (7) and SIMID (8), which Fire TV
publishers DO support, is the gap.

### Verified VAST URL spec (the publisher-facing endpoint)

The URL Limelight gives publishers to integrate has the form:

```
http://ads-247od.iionads.com/vastm/<tagid>?w=1920&h=1080&ifa=...&dmk=...&os=...&osv=...&app_bundle=...&app_name=...&display_manager=&display_manager_version=&...
```

Full parameter list (verified from a live URL, April 2026):

| Category | Params present |
|---|---|
| Identity / device | `ifa`, `dpidsha`, `dpidmd`, `ifv`, `mi`, `mv`, `gpid`, `dmk`, `dmo`, `os`, `osv`, `car`, `ip`, `ua` |
| Geo | `lat`, `lon` |
| App | `aurl`, `an`, `app_domain`, `app_name`, `app_bundle`, `b` |
| Privacy | `us_privacy`, `coppa`, `atts`, `lmt`, `gdpr`, `gdpr_consent` |
| Video constraints | `w`, `h`, `vmind`, `vmaxd`, `min_bitrate`, `max_bitrate`, `pos`, `skip`, `ap`, `mut`, `vrw`, `sd`, `ct` |
| Content | `cont_id/title/desc/dur/kw/url/cat/ln/series/genre/genre_cat/prod_quality/context/rating/media_rating/producer_*/network_*/channel_*` |
| Supply chain | `schain`, `bcat`, `badv`, `inv_partner_domain`, `sc` |
| Custom | `c1` … `c5` |
| ID sync | `eids` |
| SDK self-id (empty in observed samples) | `display_manager`, `display_manager_version` |
| Cachebuster | `cb` |

**What's NOT in the spec**: `api`, `protocols`, `simid`, `omid`, `vpaid`,
`ad_apis`, or any equivalent field for the publisher's player to declare
its interactive-ad framework support.

So Limelight has no inbound source for `api` capability data. The
`protocols: [1,2,3,7,4,5,6,8]` array in outbound bid requests is
**injected from per-tag default config** in Limelight's admin UI, not
from the publisher's URL. The same pattern could trivially be extended
to inject `api`.

### Limelight Supply Tag form schema — verified, has no api field

The "Creating and Editing Supply" page in Limelight's wiki documents
the complete supply tag creation form. URL:

```
https://limelight.cloud.xwiki.com/xwiki/bin/view/Public/Client%20Documentation/Limelight%20Ui%20User%20Documentation%20V5/1.%20Limelight%20UI%20Introduction/Publishers/Creating%20and%20Editing%20Supply/
```

For oRTB Supply Source the documented fields are:

| Type | Fields |
|---|---|
| Mandatory | Name, Type (oRTB/Tag/Header Bidding), Payout tracking (ADM/BURL), Status, Domain, Datacenter |
| Optional | Service Fee Type (None/Rev Share), Statistics API Link (for reporting only), IAB Categories, Blocked Advertiser Domain, Latency compensation |

For Tag / Header Bidding supply: also Channel (Web/App) + Ad Unit
(Banner/Video/Native Image/Native Video/Audio) hierarchy.

**No fields exist for**: API capabilities (VPAID/OMID/SIMID), Video
API frameworks, Display Manager, Supported VAST protocols. The
`protocols: [1,2,3,7,4,5,6,8]` we see in outbound bid requests must be
hardcoded at the SSP level — there's no per-supply UI override.

**Confirmed conclusion (Scenario B)**: the supply team cannot fix the
api gap from their current admin UI. The field doesn't exist to set.

### Important nuance — who SHOULD declare api per OpenRTB spec

Per OpenRTB 2.6, `imp.video.api` is supposed to be a **capability
declaration from the publisher's player**, not a supply-side config.
Only the player knows for certain what its SDK can render.

URL-based integrations like Limelight's `vastm/<tagid>?...` endpoint
break this pattern — there's no slot in a URL for the publisher's IMA
SDK to declare its capabilities. So *somebody* on the SSP side has to
either:

| Approach | Tradeoff |
|---|---|
| Supply team manual config | Burdens team with knowledge they often don't have. Publishers don't know their own SDK details, apps update without telling. Error-prone. |
| **Platform-based SSP inference** | Scales without supply-team work. Accepts ~5% edge-case errors. |
| URL parameter (`&api=...`) | Spec-correct but most publishers won't populate it. |
| `display_manager` SDK identifier | Industry standard but only works if publishers' SDKs report it. Currently empty in iion's URLs. |

**Real production SSPs use a layered approach**: default per-platform
inference as baseline (covers ~95% correctly), with optional
supply-team / URL / display-manager overrides for the rest.

So the better-scoped engineering ask for Limelight is:

> "Add platform-based default `imp.video.api` inference to outbound
> bid requests. Fire TV / Android TV / Google TV → `[7, 8]` by default.
> Roku, Apple TV → empty. Plus optionally a per-supply override and
> a URL parameter for publishers who confirm/contradict the default."

This avoids putting the supply team in the position of having to know
every publisher's SDK capabilities (a question they often can't answer
reliably).

### Sample bid request (Fire TV Stick 4K Max — same hardware as our test device)

```json
{
  "imp": [{
    "video": {
      "protocols": [1,2,3,7,4,5,6,8],
      // api: missing entirely
      "w": 1920, "h": 1080
    }
  }],
  "device": {
    "make":  "Amazon",
    "os":    "Fire OS",
    "model": "AFTMM",
    "osv":   "6.0",
    "ua":    "...AFTMM Build/NS6711; wv...Chrome/118.0.0.0..."
  }
}
```

**Despite the missing `api` field, this impression IS SIMID-renderable.**
Same hardware + Chromium version as our Fire TV testbed where we proved
it works. Route via platform inference until the bid stream signal lands.

**Option 2 — work around it (interim)**: do platform-based inference at
the DSP layer, ignoring the missing `api` field:

```pseudocode
function shouldBidSimidCreative(bidRequest) {
  if device.os in ('Android', 'Fire OS') &&
     device.make in ('Amazon', 'Google', 'TCL', 'Sony', ...): return true
  if device.os in ('Roku OS', 'tvOS'): return false
  return false  // unknown — bid plain linear to be safe
}
```

Use the **DMP funnel** (`simid_init` event ratio per publisher) as
ground truth for actual rendering rates regardless of bid signals.

---

## 22. Open items / decisions deferred

These were active topics and should be picked back up when relevant:

| Topic | Status | Next move |
|---|---|---|
| Repo privacy | Public on GitHub for now | Migrate to Cloudflare Pages → flip private. See §16. |
| DMP tracker activation | Module integrated, but disabled (no URL supplied) | Either re-add `<AdParameters>` to VAST and re-test on Fire TV, or pass `?tracker=…` on InteractiveCreativeFile URL |
| Linear audio mute | IMA Android 3.30.3 won't honor pause/volume | Production: serve a silent linear MediaFile |
| Up/Down for game vs Skip menu | Currently Up/Down reserved for Skip | Switch to Pattern C (modal-on-long-press) when shipping games that need 4-way |
| Inventory measurement | Heuristic classification done | Run dual-creative test through Limelight; query bid stream for `imp.video.api: [8]`; use DMP funnel for `simid_init` ratio per publisher |
| IMA SDK upgrade | 3.30.3 in testbed | Bump to 3.39+ if we hit SDK limitations not solvable at creative layer |

