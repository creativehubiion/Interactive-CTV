# Interactive CTV — Remote-Controlled SIMID VAST

A reference SIMID 1.1 interactive creative + VAST 4.2 tag for Connected TV.
Designed to be ad-served and rendered on Fire TV via Google's IMA SDK
inside an ExoPlayer host app, and controllable with the TV remote (D-pad +
OK + Back).

## What's in here

```
creative/
  index.html         - SIMID creative entry (loaded in the IMA iframe)
  styles.css         - TV-safe layout, focus rings sized for 1080p
  simid-protocol.js  - Minimal SIMID 1.1 creative-side postMessage wrapper
  app.js             - 2x2 D-pad selector + lifecycle wiring
  hud.js             - On-screen debug HUD (lifecycle + key events + msg I/O)

vast/
  interactive-vast.template.xml  - Source template (uses ${BASE_URL})
  interactive-vast.xml           - Built output (commit this for GH Pages)

server/
  serve.js           - Plain-Node static server with CORS + /track/* pings
  build-vast.js      - Renders the VAST template with your BASE_URL
  package.json
```

## Why SIMID, briefly

- **SIMID 1.1** is the IAB's HTML interactive ad format that *replaces* VPAID. It
  runs the creative in a sandboxed iframe and uses `postMessage` to talk to the
  player — no shared JS context, no `window.parent` hacks.
- **CTV reality (2026):** Roku, tvOS, Samsung, LG do not have first-party SIMID
  runtimes. **Google's IMA SDK for Android (3.20+) does.** Since Fire TV runs
  Fire OS (Android-derived) and ExoPlayer ships a Media3/IMA extension, the
  IMA SDK on Fire TV is your SIMID runtime. This project targets that path.
- **Remote input** is *not* part of the SIMID spec. The creative listens for
  standard DOM `keydown` events; the WebView delivers D-pad as
  `ArrowUp/Down/Left/Right` and OK as `Enter`. Back may or may not reach JS
  depending on the host app — we send `Creative:requestSkip` when we see it.

The full R&D dossier lives at the bottom of this file.

## End-to-end test on your Fire TV (your existing ExoPlayer 2.19.1 build)

You already have:
- `C:\Users\BAUHAU5\ExoPlayer\` (legacy `google/ExoPlayer` 2.19.1)
- IMA SDK **3.30.3** bundled — supports SIMID 1.0
- The `demos/main` app sideloaded on Fire TV
- ADB connection between your PC and the Fire Stick

Flow: host this repo on your LAN → write a VAST URL pointing at it → tell the
demo app to play that VAST tag.

### 1. Run the local server

```bash
cd "G:/Claude Code/Projects/Interactive CTV/server"
node serve.js
```

It prints your LAN IP. Note it — e.g. `http://192.168.1.42:8080`.

### 2. Build the VAST tag with that URL as BASE_URL

In a second terminal:

```bash
BASE_URL=http://192.168.1.42:8080 node server/build-vast.js
```

Now `vast/interactive-vast.xml` references `http://192.168.1.42:8080/...`
everywhere. Confirm it's reachable from the Fire Stick by opening the URL in
the Fire TV's Silk browser (or just trust the next step).

### 3. Hand the VAST URL to the ExoPlayer demo

You have two options.

#### Option A — quick, via ADB intent extras (no rebuild)

The legacy demo accepts an Intent extra called `ad_tag_uri`. Send it any
playable content URI plus the VAST URL:

```bash
adb shell am start -n com.google.android.exoplayer2.demo/.PlayerActivity \
  -a android.intent.action.VIEW \
  -d "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" \
  --es ad_tag_uri "http://192.168.1.42:8080/vast/interactive-vast.xml"
```

(Wrap the command in one line, or use line-continuation for your shell.)

#### Option B — add a sample to the picker

Edit `C:\Users\BAUHAU5\ExoPlayer\demos\main\src\main\assets\media.exolist.json`,
find the `"name": "IMA sample ad tags"` block, and add at the bottom:

```json
{
  "name": "Interactive CTV (SIMID, local)",
  "uri": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "ad_tag_uri": "http://192.168.1.42:8080/vast/interactive-vast.xml"
}
```

Rebuild + sideload:

```bash
./gradlew :demo:assembleNoExtensionsDebug
adb install -r demos/main/buildout/outputs/apk/noExtensions/debug/demo-noExtensions-debug.apk
```

Open the demo on Fire TV, scroll to the new entry, hit OK. The 30-second Big
Buck Bunny ad starts and the SIMID overlay appears on top.

### 4. Watch the HUD

The creative URL ends in `?debug=1`, so the on-screen HUD turns on. You should
see (top-right, green-on-black):

- `← Player:init #N` — IMA spoke SIMID. Good.
- `→ resolve` — we acknowledged init.
- `← Player:startCreative #N` — go signal received.
- `keydown key="ArrowDown" code=ArrowDown kc=40 → button#... [movies]` — your remote actually reaches JS.
- `focusin → button[sports]` — focus moves on each D-pad press.
- `→ Creative:reportTracking ... select` — selection fires the tracking ping.
- `→ Creative:requestStop` — clean teardown.

If `Player:init` never appears, the host isn't a SIMID-capable IMA build —
re-check the IMA SDK version pinned in `extensions/ima/build.gradle`.

### 5. Confirm with logcat

```bash
adb logcat | grep -iE "ima|simid|adsmanager|exoplayer"
```

IMA logs every protocol message at INFO. You'll see lines containing
`SIMID:Player:init` etc. Cross-check against the HUD.

## Hosting on GitHub Pages (creativehubiion)

Once you're happy with the local test, push this repo to
`creativehubiion/Interactive-CTV` and enable Pages on `main`. Then rebuild
the VAST tag pointing at the public URL:

```bash
BASE_URL=https://creativehubiion.github.io/Interactive-CTV node server/build-vast.js
git add vast/interactive-vast.xml && git commit -m "Build VAST for Pages" && git push
```

Public VAST tag URL becomes:

```
https://creativehubiion.github.io/Interactive-CTV/vast/interactive-vast.xml
```

That's the URL you'd hand to an ad server / SSP test slot. Whether the
downstream CTV app actually renders it depends on whether *that* app's
player implements SIMID — see the dossier below.

## Test matrix worth running

| Scenario | What it proves |
|---|---|
| Local LAN → ExoPlayer demo on Fire Stick | IMA SIMID rendering, postMessage roundtrip, D-pad reaches iframe, focus updates correctly |
| Same, but pull the Wi-Fi during the ad | Error path — `Player:fatalError` should surface in HUD |
| `?debug=0` — production-mode creative | HUD off, tracking still fires |
| Press Back during the overlay | `requestSkip` fires; OS may swallow Back at host-app level |
| Disable the IMA extension and run a non-IMA player | The 2-second auto-start fallback kicks in (proves the creative is host-tolerant) |

## Known behaviour / gotchas

- **Back button on Fire TV** is intercepted by the OS and the host Activity
  before reaching the WebView. If your host app doesn't forward Back to the
  WebView, the creative will not see it. The watchdog (15s of inactivity →
  auto-skip) is your fallback.
- **Cross-origin iframe focus**: SIMID iframes are cross-origin sandboxed. The
  *player* must call `iframe.contentWindow.focus()` once the ad is visible. IMA
  does this; a custom WebView host needs to do it explicitly.
- **First-gen Fire Sticks** ship an old WebView. Stick to ES2018-ish JS and
  avoid heavy filters / shadows. This project's CSS is intentionally cheap.
- **VPAID is dead on CTV.** This project does not produce VPAID and IMA on
  Android explicitly does not run it.

---

## R&D dossier

### SIMID 1.1 in one screen

- Spec: <https://interactiveadvertisingbureau.github.io/SIMID/>
- Protocol: JSON envelopes over `Window.postMessage`. Every message has
  `protocol: "SIMID"`, a monotonically increasing `messageId`, a `sessionId`,
  a `type` (e.g. `Player:init`, `Creative:requestStop`), `args`, and
  `timestamp`. Acks are `type: "resolve"` / `"reject"` carrying the original
  `messageId`.
- Lifecycle: `Player:init → Creative resolve → Player:startCreative → … → adStopped/adSkipped/fatalError`.
- Iframe model: cross-origin sandboxed, full video region by default,
  positioned above the `<video>` element.
- The spec is **silent on TV remote input** — there is no
  `Player:inputFocusGranted`, no key delivery message. Creatives listen for
  DOM `keydown`, full stop. This is a known gap for CTV.

### What actually renders SIMID on CTV in 2026

| Platform | Status |
|---|---|
| Google IMA HTML5 | Yes (SIMID 1.0+) |
| Google IMA Android (incl. ExoPlayer extension) | **Yes (SIMID 1.0)** ← this is what we use |
| Google IMA iOS | Yes |
| Google IMA tvOS | **No** (red X in compatibility table) |
| Roku (RAF / SceneGraph) | No first-party SIMID — Roku interactive goes through BrightLine / Innovid |
| Samsung Tizen, LG webOS | Browser engine could host it; no public ad-serving stack ships SIMID compliance |
| Fire TV native player | None published; bring-your-own (this project demonstrates ExoPlayer + IMA) |
| AWS MediaTailor | Server-side passthrough only — client still has to render |

Practical implication: a SIMID VAST tag delivered into a CTV slot is *passed
through* by every major SSP (FreeWheel, SpringServe, Publica), but whether
the player at the end of the chain renders it is up to that player. Your
test stack — IMA SDK on Android — does.

### IMA SDK + ExoPlayer relationship

- The Media3 / ExoPlayer IMA extension is an `AdsLoader` wrapper around the
  IMA Android SDK. The string `"SIMID"` doesn't appear in the extension's
  source — the extension delegates to IMA, and IMA contains the SIMID
  runtime.
- Your bundled version: `com.google.ads.interactivemedia.v3:interactivemedia:3.30.3`
  (see `extensions/ima/build.gradle`). SIMID 1.0 was added to IMA Android in
  3.20 (May 2020), so 3.30.3 supports it.

### Sources

- [IAB SIMID spec](https://interactiveadvertisingbureau.github.io/SIMID/) · [GitHub repo](https://github.com/InteractiveAdvertisingBureau/SIMID)
- [IMA Android compatibility table](https://developers.google.com/interactive-media-ads/docs/sdks/android/client-side/compatibility)
- [Google Ads Developer Blog — SIMID in IMA, May 2020](https://ads-developers.googleblog.com/2020/05/simid-support-in-interactive-media-ads.html)
- [IAB VAST CTV Addendum 2024](https://iabtechlab.com/wp-content/uploads/2024/07/VAST-CTV-Addendum-2024-FINAL.pdf)
- [AWS MediaTailor SIMID handling](https://docs.aws.amazon.com/mediatailor/latest/ug/ad-reporting-client-side-ad-tracking-schema-player-controls-simid-ads.html)
- [Amazon Fire TV controller input](https://developer.amazon.com/docs/fire-tv/remote-input.html)
- [ExoPlayer 2.19.1 IMA extension](https://github.com/google/ExoPlayer/tree/release-v2/extensions/ima)
