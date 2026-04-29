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

The creative is a D-pad-navigable selector with on-screen debug HUD,
controllable by the TV remote. The whole thing is served from GitHub
Pages at `https://creativehubiion.github.io/Interactive-CTV`.

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
