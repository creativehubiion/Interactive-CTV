# Production integration — wiring the SIMID creative to your RTB stack

This doc describes how to connect the creative to iion's tracker / DMP via
**PLL macros** that the DSP/SSP fills in at request time. The creative
itself contains zero hardcoded campaign / publisher / creative identifiers
— everything that varies per impression flows in via `<AdParameters>`.

## The wire format

When iion's DSP/SSP generates the VAST tag for an impression, include an
`<AdParameters>` block inside the `<Linear>` element with a JSON payload
containing the **already-macro-replaced** tracker URL:

```xml
<Linear>
  <Duration>00:00:30</Duration>
  ...
  <MediaFiles>
    <MediaFile delivery="progressive" type="video/mp4">
      https://your-cdn/linear.mp4
    </MediaFile>
    <InteractiveCreativeFile type="text/html" apiFramework="SIMID" variableDuration="true">
      https://creativehubiion.github.io/Interactive-CTV/creative/index.html
    </InteractiveCreativeFile>
  </MediaFiles>
  <AdParameters><![CDATA[{
    "tracker_url": "https://staging-dmp-producer.iion.io/tracker/impressions?platform=RTB&campaign_id=%%campaignId%%&publisher_id=%%pubId%%&creative_id=%%creativeId%%&request_id=%%requestId%%&user_id=%%userId%%&ip_address=%%ip%%&app_id_bundle_id=%%bundle%%&maid=%%ifa%%&app_name=%%appName%%&os=%%os%%&user_agent=%%userAgentEnc%%&latitude=%%lat%%&longitude=%%lon%%&page_url=%%pageUrl%%&country=%%country%%&device_make=%%deviceMake%%&domain=%%domain%%&height=%%height%%&width=%%width%%&video_min_duration=%%videoMinDuration%%&video_max_duration=%%videoMaxDuration%%&content_genre=%%contgenre%%&content_cat=%%contcat%%&gdpr=%%gdpr%%&gdpr_consent=%%gdprConsent%%&demand_id=%%demandId%%&line_item=%%adgroupId%%&event_name="
  }]]></AdParameters>
</Linear>
```

**Critical**: the seller (DSP/SSP) must replace every `%%xxxxx%%` macro with
the actual value before the VAST is delivered to the publisher's player.
The creative does not perform macro substitution — by the time the URL
reaches the iframe, every `%%campaignId%%`, `%%pubId%%`, etc. should
already be filled in.

The trailing `&event_name=` (with empty value) is intentional — the
creative concatenates the event name onto that. So a fired impression
URL looks like:

```
https://staging-dmp-producer.iion.io/tracker/impressions?platform=RTB&campaign_id=CAMP_001&publisher_id=PUB_42&creative_id=CR_FRUITCATCH&...&event_name=simid_init
```

## Alternative: pass via creative URL query string

For ad-hoc testing outside the RTB pipeline, override via the creative URL:

```
https://creativehubiion.github.io/Interactive-CTV/creative/index.html?tracker=<URL-encoded full tracker URL>
```

Useful for development; not how production should look.

## Events the creative fires

Funnel events, in fire order:

| Event | When |
|---|---|
| `simid_init` | Player:init received + acknowledged — proves the iframe loaded and IMA is talking to it |
| `simid_start` | Player:startCreative — IMA gave the green light to render |
| `game_start` | Game-loop began |
| `first_input` | First D-pad press from the user — actual engagement, not just visibility |
| `fruit_catch` | Per-collision good catch (extra: `glyph`, `score`) |
| `bomb_catch` | Per-collision bad catch (extra: `glyph`, `score`) |
| `game_complete` | 30 s round finished (extra: `score`) |
| `inactivity_timeout` | 60 s of zero remote input |
| `hard_cap` | 180 s reached, force-exit |
| `teardown` | Final exit (extra: `reason`) |
| `game_start_error` | JS error during boot (extra: `message`) |

## Funnel queries for the DMP

After test traffic, the renderability + engagement question per publisher
is a single query:

```sql
SELECT publisher_id, app_id_bundle_id, os,
       COUNT(*)                                                        AS impressions,
       SUM(CASE WHEN event_name = 'simid_init'    THEN 1 ELSE 0 END)   AS rendered,
       SUM(CASE WHEN event_name = 'simid_start'   THEN 1 ELSE 0 END)   AS started,
       SUM(CASE WHEN event_name = 'first_input'   THEN 1 ELSE 0 END)   AS engaged,
       SUM(CASE WHEN event_name = 'game_complete' THEN 1 ELSE 0 END)   AS completed,
       100.0 * SUM(CASE WHEN event_name = 'simid_init'    THEN 1 ELSE 0 END) / COUNT(*) AS pct_rendered,
       100.0 * SUM(CASE WHEN event_name = 'first_input'   THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN event_name = 'simid_init' THEN 1 ELSE 0 END), 0) AS pct_engaged_of_rendered
FROM dmp_events
WHERE creative_id = 'CR_FRUITCATCH' AND ts >= NOW() - INTERVAL '14 days'
GROUP BY publisher_id, app_id_bundle_id, os
ORDER BY impressions DESC;
```

`pct_rendered` per publisher tells you what fraction of that publisher's
inventory **actually supports SIMID** at the impression level. That's the
ground truth — converts every "maybe" inventory bucket into measured.

## Gotchas

- **Don't add `<AdParameters>` to the production VAST until tested**. We
  removed it from the deployed VAST earlier because IMA Android 3.30.3
  was finicky about its presence in some configurations. Re-test before
  shipping it broadly. If broken, fall back to passing the tracker URL
  as a `?tracker=…` query string on the InteractiveCreativeFile URL.
- **The tracker URL must be HTTPS**. Mixed-content blocks fire-and-forget
  pixels in the WebView.
- **Don't URL-encode the macros yourself**. They go into the URL literally
  as `%%campaignId%%` and the SSP replaces them before delivering. If you
  encode them to `%25%25campaignId%25%25`, the SSP won't recognize the
  pattern.
- **`event_name=` should be the LAST param** in the template URL, with
  empty value. The creative concatenates the event name to it directly.
