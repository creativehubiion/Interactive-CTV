/**
 * CTV inventory SIMID-renderability classifier.
 *
 * Reads a pdftotext -layout extraction of an inventory file with columns:
 *   gaming_inventory_type | game_name | bundle_id | country | platform |
 *   gaming_platform | placement_type | game_url | genre | sub_genre |
 *   ad_format | ad_requests | inventory_type | publisher_source
 *
 * For each unique (platform, bundle_id, app_name) row:
 *   - Heuristically classifies SIMID-renderability based on platform +
 *     app-name pattern + publisher source (WURL vs Playwork etc.)
 *   - For Fire TV ASINs and Android package IDs, derives the developer
 *     URL via the appropriate store
 *   - Where possible, fetches the developer's app-ads.txt and detects
 *     Google ad-stack presence (high IMA probability) or known SSAI
 *     vendor signatures (FreeWheel SSAI, MediaTailor, SpringServe)
 *   - Outputs an aggregated CSV report
 *
 * Run:
 *   node tools/classify-inventory.js [path/to/inventory.txt] [out.csv]
 *
 * No external dependencies — uses Node's built-in https module.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const IN_PATH  = process.argv[2] || path.join(__dirname, 'ctv-inventory-raw.txt');
const OUT_PATH = process.argv[3] || path.join(__dirname, 'ctv-inventory-classified.csv');

// ---- Platform → SIMID baseline classification --------------------------------
// Each entry: which IMA SDK variant (if any) the platform uses, and the typical
// insertion model. SIMID requires Client-Side Ad Insertion + a SIMID-capable
// IMA SDK (Android, HTML5) at minimum.
const PLATFORM_PROFILE = {
  'Fire TV':     { ima: 'Android',  ssaiTypical: 'mixed',  baseline: 'yes',     reason: 'Fire OS = Android-derived; IMA Android SDK supports SIMID 1.0' },
  'Android':     { ima: 'Android',  ssaiTypical: 'mixed',  baseline: 'yes',     reason: 'Android TV / Google TV; IMA Android SDK supports SIMID 1.0' },
  'GoogleTV':    { ima: 'Android',  ssaiTypical: 'mixed',  baseline: 'yes',     reason: 'Google TV runs Android; IMA Android SDK supports SIMID' },
  'Roku':        { ima: 'none',     ssaiTypical: 'mostly', baseline: 'no',      reason: 'Roku uses Roku Ad Framework (RAF) + BrightLine/Innovid; no first-party SIMID' },
  'TCL':         { ima: 'split',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'TCL ships both Roku TV (no SIMID) and Google TV (yes SIMID) variants; depends on model' },
  'Samsung':     { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'Tizen (web-based); SIMID renders if app uses IMA HTML5 — most use Samsung Ads stack instead' },
  'Samsung CTV': { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'Tizen (web-based); SIMID renders if app uses IMA HTML5 — most use Samsung Ads stack instead' },
  'LG':          { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'webOS (web-based); same as Samsung — depends on whether app uses IMA HTML5' },
  'Vizio':       { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'SmartCast (web-based); SIMID renders if app uses IMA HTML5' },
  'Vidaa':       { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'Hisense Vidaa OS (Linux+browser); depends on IMA HTML5 usage' },
  'Hisense':     { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'Either Vidaa OS or Android TV — varies by model' },
  'Vewd':        { ima: 'HTML5',    ssaiTypical: 'mostly', baseline: 'maybe',   reason: 'Vewd Smart TV browser — depends on app' },
  'Comcast':     { ima: 'unknown',  ssaiTypical: 'mostly', baseline: 'unlikely',reason: 'Xfinity X1 set-top box runs custom RDK runtime; usually SSAI' },
  'Videotron':   { ima: 'unknown',  ssaiTypical: 'mostly', baseline: 'unlikely',reason: 'Cable STB; usually SSAI' },
  'Rogers':      { ima: 'unknown',  ssaiTypical: 'mostly', baseline: 'unlikely',reason: 'Cable STB; usually SSAI' },
  'Cox':         { ima: 'unknown',  ssaiTypical: 'mostly', baseline: 'unlikely',reason: 'Cable STB; usually SSAI' },
  'Xumo':        { ima: 'mixed',    ssaiTypical: 'almost', baseline: 'unlikely',reason: 'Xumo Play (now Comcast); FAST = SSAI typically' },
  'Tubi':        { ima: 'unknown',  ssaiTypical: 'mostly', baseline: 'unlikely',reason: 'Fox-owned Tubi runs its own ad SDK; SIMID acceptance unconfirmed' },
};

// ---- App-name patterns hinting at insertion model ----------------------------
// FAST (free ad-supported streaming TV) channels and 24h live channels are
// almost universally SSAI to keep the stream continuous.
const FAST_PATTERNS = [
  /\b24[\s_-]?hour\b/i,
  /\bnews\s*now\b/i,
  /\b\d+news\b/i,
  /\bchannel\b/i,
  /\bnetwork\b/i,
  /\btv\b/i,
  /\blive\b/i,
];

// ---- Publisher_source patterns (the rightmost column) -----------------------
// WURL (Roku-owned FAST-channel CDN) → mostly SSAI, mostly Roku ecosystem.
// Playwork → mixed; varies by individual integration.
const SOURCE_PROFILE = {
  WURL:     { hint: 'WURL is a Roku-owned FAST channel network → predominantly SSAI; even on Fire TV inventory, the channel itself is SSAI' },
  Playwork: { hint: 'Playwork is a CTV game ad network; insertion model varies by destination app' },
};

// ---- Known CTV publisher domains for live app-ads.txt probing ---------------
// Direct probes; only used for sampled lookups since we don't want to hammer
// 9,425 hostnames in sequence. Add to this map as needed.
const KNOWN_PUBLISHER_DOMAINS = {
  'Pluto TV':              'https://pluto.tv/app-ads.txt',
  'Tubi':                  'https://tubitv.com/app-ads.txt',
  'Samsung':               'https://www.samsung.com/app-ads.txt',
  'TCL':                   'https://www.tcl.com/app-ads.txt',
  'Vizio':                 'https://www.vizio.com/app-ads.txt',
  'Roku':                  'https://www.roku.com/app-ads.txt',
  'Hisense / Vidaa':       'https://www.vidaa.com/app-ads.txt',
  'LG (lgsmartworld)':     'https://lgsmartworld.com/app-ads.txt',
  'Xumo':                  'https://www.xumo.com/app-ads.txt',
  'Comcast / Xfinity':     'https://www.xfinity.com/app-ads.txt',
};

// ---- HTTP helpers ------------------------------------------------------------
function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.get({
        hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
        headers: { 'User-Agent': 'Mozilla/5.0 (CTVInventoryClassifier/1.0)' },
        timeout: 8000,
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && redirectsLeft > 0 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchText(next, redirectsLeft - 1));
        }
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error',   () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    } catch (e) {
      resolve({ status: 0, body: '' });
    }
  });
}

// ---- Classify an app-ads.txt body --------------------------------------------
function classifyAppAdsTxt(body) {
  const lower = body.toLowerCase();
  const lines = lower.split('\n').filter(l => l && !l.startsWith('#'));
  const result = {
    totalLines: lines.length,
    googleEntries: 0,        // google.com → very likely IMA Client-Side
    googleAdsEntries: 0,     // googleads.g.doubleclick.net → IMA strongly implied
    freewheelEntries: 0,     // FreeWheel = often SSAI
    mediatailorMentions: 0,  // AWS MediaTailor = SSAI
    springserveEntries: 0,   // SpringServe = often SSAI
    publicaEntries: 0,       // Publica = SSAI
    innovidEntries: 0,       // Innovid = interactive (proprietary, not SIMID)
    brightlineEntries: 0,    // BrightLine = interactive (proprietary)
    truexEntries: 0,         // Truex = interactive (proprietary)
    rubiconEntries: 0,
    pubmaticEntries: 0,
    magniteEntries: 0,
    fanuEntries: 0,
  };
  for (const line of lines) {
    if (line.includes('google.com'))                       result.googleEntries++;
    if (line.includes('googleads.g.doubleclick'))          result.googleAdsEntries++;
    if (line.includes('freewheel.tv'))                     result.freewheelEntries++;
    if (line.includes('mediatailor'))                      result.mediatailorMentions++;
    if (line.includes('springserve.com'))                  result.springserveEntries++;
    if (line.includes('publica.com'))                      result.publicaEntries++;
    if (line.includes('innovid.com'))                      result.innovidEntries++;
    if (line.includes('brightline'))                       result.brightlineEntries++;
    if (line.includes('truex'))                            result.truexEntries++;
    if (line.includes('rubiconproject') || line.includes('magnite.com')) result.magniteEntries++;
    if (line.includes('pubmatic.com'))                     result.pubmaticEntries++;
  }
  return result;
}

function appAdsTxtVerdict(c) {
  if (c.totalLines === 0) return { verdict: 'no-data', reason: 'app-ads.txt empty or unreachable' };
  const score = [];
  // Strong yes for IMA presence
  if (c.googleAdsEntries > 0)  score.push(`${c.googleAdsEntries}× googleads.g.doubleclick (IMA strongly implied)`);
  if (c.googleEntries > 5)     score.push(`${c.googleEntries}× google.com entries (Google ad stack heavily integrated)`);
  else if (c.googleEntries > 0) score.push(`${c.googleEntries}× google.com entry (Google partial)`);
  // SSAI/proprietary signals
  if (c.freewheelEntries > 0)  score.push(`${c.freewheelEntries}× FreeWheel (often used in SSAI / FAST flows)`);
  if (c.mediatailorMentions > 0) score.push(`AWS MediaTailor (SSAI provider)`);
  if (c.springserveEntries > 0) score.push(`${c.springserveEntries}× SpringServe (often SSAI)`);
  if (c.publicaEntries > 0)     score.push(`${c.publicaEntries}× Publica (SSAI specialist)`);
  // Proprietary interactive (counter-signal vs SIMID)
  if (c.innovidEntries > 0)     score.push(`${c.innovidEntries}× Innovid (proprietary interactive)`);
  if (c.brightlineEntries > 0)  score.push(`${c.brightlineEntries}× BrightLine (proprietary interactive)`);
  if (c.truexEntries > 0)       score.push(`${c.truexEntries}× Truex (proprietary interactive)`);

  let verdict;
  if (c.googleAdsEntries > 0 || c.googleEntries > 5) {
    verdict = c.mediatailorMentions || c.publicaEntries || c.springserveEntries
      ? 'ima-likely-but-mixed-with-ssai'
      : 'ima-likely';
  } else if (c.googleEntries > 0) {
    verdict = 'partial-google';
  } else {
    verdict = 'no-google';
  }
  return { verdict, reason: score.join(' · ') || 'no recognizable ad-stack signatures' };
}

// ---- Inventory parser --------------------------------------------------------
// The pdftotext output is space-aligned. We detect column positions by anchor
// strings ("Fire TV", "Roku", etc.) and country names. We don't need perfect
// extraction — we extract the platform field and the bundle_id, which is
// what actually matters for classification.
function parseInventory(txt) {
  const lines = txt.split('\n');
  const rows = [];
  const platforms = Object.keys(PLATFORM_PROFILE);
  const platformRegex = new RegExp('\\b(' + platforms.map(p => p.replace(/\s/g, '\\s')).join('|') + ')\\b');
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || line.startsWith('gaming_inventory_type')) continue;
    const platMatch = line.match(platformRegex);
    if (!platMatch) continue;
    const platform = platMatch[1].replace(/\s/g, ' ');
    // Bundle id: alphanumeric token ≥ 6 chars, not a country, not a sentence word.
    // Common shapes: B01LYZ2GD4 (Amazon ASIN), com.example.app, vizio.localnow, B09G534MQX, b01mqtvn2t
    const idMatch = line.match(/\b(B0[A-Z0-9]{8}|b0[a-z0-9]{8}|[a-z][a-z0-9_-]+\.[a-z0-9_.-]+)\b/);
    const bundleId = idMatch ? idMatch[0] : '';
    // Source token: rightmost _CTV_ATG_ pattern.
    const sourceMatch = line.match(/(WURL|Playwork|Wurl)_CTV_ATG[A-Za-z0-9_]+/);
    const source = sourceMatch ? sourceMatch[1] : '';
    // App name: take 3-5 words before bundle_id if present; else first chunk after "Around the Game".
    let app = '';
    if (bundleId) {
      const idx = line.indexOf(bundleId);
      const prefix = line.slice(0, idx).trim();
      const m = prefix.match(/(?:Around the Game)?\s*(.+)$/);
      if (m) app = m[1].trim();
    }
    rows.push({ platform, bundleId, source, app, raw: line });
  }
  return rows;
}

// ---- Heuristic classification per row ---------------------------------------
function classifyRow(row) {
  const profile = PLATFORM_PROFILE[row.platform] || { baseline: 'unknown', reason: 'unknown platform' };
  let verdict = profile.baseline;
  const reasons = [profile.reason];

  // FAST channel app-name = strong SSAI signal regardless of platform.
  if (FAST_PATTERNS.some(p => p.test(row.app))) {
    if (verdict === 'yes')   verdict = 'maybe';
    if (verdict === 'maybe') verdict = 'unlikely';
    reasons.push(`app-name pattern suggests FAST/24h channel → SSAI typical`);
  }

  // WURL source → Roku ecosystem, mostly SSAI, even on Fire TV.
  if (row.source === 'WURL' || row.source === 'Wurl') {
    if (verdict === 'yes')   verdict = 'maybe';
    if (verdict === 'maybe') verdict = 'unlikely';
    reasons.push('publisher_source = WURL (Roku-owned FAST distribution → SSAI typical)');
  }

  return { verdict, reasons };
}

// ---- Main --------------------------------------------------------------------
(async () => {
  console.log(`Reading ${IN_PATH}...`);
  const txt = fs.readFileSync(IN_PATH, 'utf8');
  const rows = parseInventory(txt);
  console.log(`Parsed ${rows.length} inventory lines.`);

  // Aggregate per (platform, app, bundle_id, source) tuple.
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.platform}|${r.bundleId}|${r.app}|${r.source}`;
    if (!seen.has(key)) seen.set(key, { ...r, occurrences: 0 });
    seen.get(key).occurrences++;
  }
  console.log(`Unique (platform, bundle, app, source) combos: ${seen.size}`);

  // Per-row classification.
  const classified = [];
  for (const r of seen.values()) {
    const c = classifyRow(r);
    classified.push({ ...r, verdict: c.verdict, reasons: c.reasons.join(' | ') });
  }

  // Aggregated stats.
  const counts = { yes: 0, maybe: 0, unlikely: 0, no: 0, unknown: 0 };
  for (const c of classified) counts[c.verdict] = (counts[c.verdict] || 0) + c.occurrences;
  console.log('\n=== SIMID-renderability rollup (by occurrences) ===');
  for (const k of Object.keys(counts)) {
    const pct = (counts[k] / rows.length * 100).toFixed(1);
    console.log(`  ${k.padEnd(10)} ${String(counts[k]).padStart(6)}  (${pct}%)`);
  }

  // By platform.
  const byPlat = new Map();
  for (const c of classified) {
    const k = c.platform;
    if (!byPlat.has(k)) byPlat.set(k, { yes: 0, maybe: 0, unlikely: 0, no: 0, unknown: 0 });
    byPlat.get(k)[c.verdict] += c.occurrences;
  }
  console.log('\n=== By platform (occurrences) ===');
  console.log('  ' + ['platform', 'yes', 'maybe', 'unlikely', 'no'].map(s => s.padEnd(12)).join(''));
  [...byPlat.entries()].sort((a, b) => {
    const ta = Object.values(a[1]).reduce((x, y) => x + y, 0);
    const tb = Object.values(b[1]).reduce((x, y) => x + y, 0);
    return tb - ta;
  }).forEach(([plat, c]) => {
    console.log('  ' + [plat, c.yes, c.maybe, c.unlikely, c.no].map(s => String(s).padEnd(12)).join(''));
  });

  // Live app-ads.txt probes for known publisher domains.
  console.log('\n=== Live app-ads.txt probes (ad-stack fingerprinting) ===');
  const probeResults = [];
  for (const [name, url] of Object.entries(KNOWN_PUBLISHER_DOMAINS)) {
    process.stdout.write(`  ${name.padEnd(22)} → `);
    const res = await fetchText(url);
    if (res.status !== 200 || !res.body) {
      console.log(`HTTP ${res.status} (skipped)`);
      probeResults.push({ name, url, status: res.status, verdict: 'no-data', reason: '' });
      continue;
    }
    const c = classifyAppAdsTxt(res.body);
    const v = appAdsTxtVerdict(c);
    console.log(`${v.verdict.padEnd(30)} ${v.reason}`);
    probeResults.push({ name, url, status: 200, ...v, ...c });
  }

  // Write CSV.
  const csvLines = [
    ['platform', 'verdict', 'app', 'bundle_id', 'source', 'occurrences', 'reasons'].join(','),
    ...classified
      .sort((a, b) => b.occurrences - a.occurrences)
      .map(c => [
        c.platform, c.verdict, c.app, c.bundleId, c.source, c.occurrences,
        '"' + c.reasons.replace(/"/g, '""') + '"',
      ].map(v => String(v).replace(/[\r\n,]/g, ' ')).join(',')),
  ];
  fs.writeFileSync(OUT_PATH, csvLines.join('\n'));
  console.log(`\nWrote ${OUT_PATH}  (${classified.length} unique rows)`);

  // Probe-results JSON for reference.
  const probeOut = OUT_PATH.replace(/\.csv$/, '-probes.json');
  fs.writeFileSync(probeOut, JSON.stringify(probeResults, null, 2));
  console.log(`Wrote ${probeOut}  (live probes)`);

  console.log('\n=== Headline takeaway ===');
  const yesPct      = (counts.yes      / rows.length * 100).toFixed(1);
  const maybePct    = (counts.maybe    / rows.length * 100).toFixed(1);
  const unlikelyPct = (counts.unlikely / rows.length * 100).toFixed(1);
  console.log(`  ✅ SIMID-likely:    ${yesPct}%  (Fire TV / Android TV with IMA Android SDK)`);
  console.log(`  ⚠️  Maybe:           ${maybePct}%  (Samsung/LG/Vizio/Vidaa — IMA HTML5 if integrated)`);
  console.log(`  ❌ Unlikely:        ${unlikelyPct}%  (Roku, FAST channels via WURL, set-top boxes)`);
})();
