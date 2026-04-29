/**
 * Per-bundle live probe: takes the unique bundle IDs from the inventory and,
 * for each one, attempts to:
 *   1. Resolve the bundle ID → developer URL via the appropriate store:
 *      - Amazon ASIN (B0XXXXXXXX or b0xxxxxxxx) → amazon.com/dp/{asin}
 *      - Google Play package (com.x.y) → play.google.com/store/apps/details?id={pkg}
 *      - Vendor-prefixed IDs (com.vizio.X, com.vewd.X, com.vidaa.X, vizio.X)
 *        → typically still the same package on Play Store
 *   2. Scrape the developer's website URL from that listing
 *   3. Fetch <developer>/app-ads.txt (and ads.txt as a fallback)
 *   4. Classify ad-stack signatures (Google IMA presence, SSAI provider
 *      presence, proprietary interactive providers)
 *
 * Designed to be re-runnable. Caches results to disk so partial runs resume.
 *
 * Run:
 *   node tools/probe-bundles.js [classified.csv] [out.json]
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { URL } = require('url');

const IN_PATH    = process.argv[2] || path.join(__dirname, 'ctv-inventory-classified.csv');
const OUT_PATH   = process.argv[3] || path.join(__dirname, 'bundle-probes.json');
const CACHE_PATH = path.join(__dirname, 'bundle-probes-cache.json');

const MAX_BUNDLES        = parseInt(process.env.MAX_BUNDLES   || '120', 10);
const CONCURRENCY        = parseInt(process.env.CONCURRENCY    || '4',  10);
const BETWEEN_REQUEST_MS = parseInt(process.env.PROBE_DELAY_MS || '200', 10);

// ---- HTTP helper -------------------------------------------------------------
function fetchText(url, redirectsLeft = 5, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, body: '', url }); }
    const req = https.get({
      hostname: u.hostname, path: (u.pathname || '/') + (u.search || ''),
      port: u.port || 443,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirectsLeft > 0 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, redirectsLeft - 1, timeoutMs));
      }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 4_000_000) req.destroy(); });
      res.on('end',   () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('error',   () => resolve({ status: 0, body: '', url }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', url }); });
  });
}

// ---- Bundle ID type detection ------------------------------------------------
function classifyBundleId(id) {
  if (!id) return 'empty';
  if (/^b0[a-z0-9]{8}$/i.test(id)) return 'amazon-asin';
  if (/^com\./i.test(id) || /^[a-z][a-z0-9_]+\.[a-z][a-z0-9_.-]+/i.test(id)) return 'package-name';
  return 'unknown';
}

// ---- Resolve developer URL from store listing --------------------------------
async function resolveDeveloperFromAmazon(asin) {
  const r = await fetchText(`https://www.amazon.com/dp/${asin}`);
  if (r.status !== 200) return { source: 'amazon', status: r.status, devUrl: '', publisher: '' };
  // Heuristic regex: look for "Visit the X Store", developer byline, or visit-store URL.
  const html = r.body;
  // 1) "By <publisher>" near the top of detail page.
  const by = html.match(/(?:bylineInfo|byline-info)["\s]*>?[^<]*?<[^>]*>([^<]{1,80})<\/?[a-z]/i);
  // 2) Developer/Manufacturer URL — sometimes present in product details.
  const url = html.match(/href="(https?:\/\/[^"]+)"\s*[^>]*>\s*(?:Visit Developer Website|Manufacturer Website|Visit Publisher Website|Developer Website)/i);
  return {
    source: 'amazon',
    status: r.status,
    publisher: by ? by[1].trim() : '',
    devUrl: url ? url[1] : '',
  };
}

async function resolveDeveloperFromPlayStore(pkg) {
  const r = await fetchText(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=us`);
  if (r.status !== 200) return { source: 'playstore', status: r.status, devUrl: '', publisher: '' };
  const html = r.body;
  // Developer website link. Modern Play Store HTML uses an <a> with WHfSMf class
  // OR has a 'Developer website' label nearby.
  const url = html.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>\s*Visit website/i)
           || html.match(/itemprop="url"[^>]*href="(https?:\/\/[^"]+)"/i)
           || html.match(/href="(https?:\/\/[^"]+)"[^>]{0,40}(?:Visit website|Developer website)/i);
  // Publisher / developer name.
  const dev = html.match(/<a[^>]+>([^<]{2,80})<\/a>[^<]*<\/span>\s*<\/div>\s*<\/div>\s*<\/header>/);
  return {
    source: 'playstore',
    status: r.status,
    publisher: dev ? dev[1].trim() : '',
    devUrl: url ? url[1] : '',
  };
}

async function resolveDeveloper(bundle) {
  const kind = classifyBundleId(bundle);
  if (kind === 'amazon-asin')   return resolveDeveloperFromAmazon(bundle.toUpperCase());
  if (kind === 'package-name')  return resolveDeveloperFromPlayStore(bundle);
  return { source: 'unsupported', status: 0, devUrl: '', publisher: '' };
}

// ---- Fetch + classify app-ads.txt --------------------------------------------
async function fetchAppAdsFor(devUrl) {
  if (!devUrl) return null;
  let host;
  try { host = new URL(devUrl).hostname.replace(/^www\./, ''); } catch { return null; }
  // Try www.<host>/app-ads.txt and <host>/app-ads.txt and ads.txt as fallback.
  const candidates = [
    `https://www.${host}/app-ads.txt`,
    `https://${host}/app-ads.txt`,
    `https://www.${host}/ads.txt`,
  ];
  for (const url of candidates) {
    const r = await fetchText(url, 3, 8000);
    if (r.status === 200 && r.body && r.body.length < 1_500_000) {
      return { url, status: 200, body: r.body };
    }
  }
  return { url: candidates[0], status: 404, body: '' };
}

function classifyAdsTxt(body) {
  const lower = body.toLowerCase();
  const lines = lower.split('\n').filter(l => l && !l.startsWith('#'));
  const c = {
    totalLines: lines.length,
    google: 0, googleAds: 0, admob: 0, admanager: 0,
    freewheel: 0, mediatailor: 0, springserve: 0, publica: 0, magnite: 0, pubmatic: 0,
    innovid: 0, brightline: 0, truex: 0,
  };
  for (const line of lines) {
    if (line.includes('google.com'))                       c.google++;
    if (line.includes('googleads.g.doubleclick'))          c.googleAds++;
    if (line.includes('admob.com'))                        c.admob++;
    if (line.includes('admanager') || line.includes('googleadmanager')) c.admanager++;
    if (line.includes('freewheel.tv'))                     c.freewheel++;
    if (line.includes('mediatailor'))                      c.mediatailor++;
    if (line.includes('springserve.com'))                  c.springserve++;
    if (line.includes('publica.com'))                      c.publica++;
    if (line.includes('innovid.com'))                      c.innovid++;
    if (line.includes('brightline'))                       c.brightline++;
    if (line.includes('truex'))                            c.truex++;
    if (line.includes('rubiconproject') || line.includes('magnite.com')) c.magnite++;
    if (line.includes('pubmatic.com'))                     c.pubmatic++;
  }
  // Verdict:
  let verdict;
  if (c.totalLines === 0) verdict = 'no-data';
  else if (c.google > 5 || c.googleAds > 0) verdict = 'ima-likely';
  else if (c.google > 0)                    verdict = 'partial-google';
  else                                      verdict = 'no-google';
  // SSAI/proprietary side-effects:
  const ssaiSignal = c.freewheel + c.mediatailor + c.springserve + c.publica;
  const propInteractiveSignal = c.innovid + c.brightline + c.truex;
  return { verdict, ssaiSignal, propInteractiveSignal, ...c };
}

// ---- Read inventory CSV ------------------------------------------------------
function readInventoryCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    // Naive CSV split — our writer doesn't quote commas in values (we sanitised).
    const parts = lines[i].split(',');
    const r = {};
    for (let j = 0; j < header.length; j++) r[header[j]] = parts[j];
    rows.push(r);
  }
  return rows;
}

// ---- Main --------------------------------------------------------------------
(async () => {
  const inv = readInventoryCsv(IN_PATH);
  // Pick unique bundles, prioritising rows with "maybe"/"yes" verdicts and
  // higher occurrences (so we focus probing budget on the inventory that
  // matters).
  const byBundle = new Map();
  for (const r of inv) {
    const id = (r.bundle_id || '').trim();
    if (!id) continue;
    const kind = classifyBundleId(id);
    if (kind === 'unknown' || kind === 'empty') continue;
    const key = id.toLowerCase();
    if (!byBundle.has(key)) {
      byBundle.set(key, { bundle: id, kind, app: r.app, platforms: new Set(), occurrences: 0, verdicts: new Set() });
    }
    const e = byBundle.get(key);
    e.platforms.add(r.platform);
    e.occurrences += parseInt(r.occurrences || '1', 10) || 1;
    e.verdicts.add(r.verdict);
  }

  const sorted = [...byBundle.values()].sort((a, b) => b.occurrences - a.occurrences);
  console.log(`Discovered ${sorted.length} unique probe-able bundle IDs (Amazon ASINs + package names).`);

  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}
  }

  const todo = sorted.slice(0, MAX_BUNDLES).filter(b => !cache[b.bundle.toLowerCase()]);
  console.log(`Probing top ${Math.min(MAX_BUNDLES, sorted.length)} bundles by occurrence count (${todo.length} new, ${MAX_BUNDLES - todo.length} cached).`);

  let done = 0;
  async function probeOne(entry) {
    const dev = await resolveDeveloper(entry.bundle);
    let ads = null, ver = null;
    if (dev.devUrl) {
      ads = await fetchAppAdsFor(dev.devUrl);
      if (ads && ads.status === 200) ver = classifyAdsTxt(ads.body);
    }
    cache[entry.bundle.toLowerCase()] = {
      bundle: entry.bundle, kind: entry.kind, app: entry.app,
      platforms: [...entry.platforms], occurrences: entry.occurrences,
      developerLookup: dev,
      adsTxt: ads ? { url: ads.url, status: ads.status, hasBody: !!ads.body } : null,
      verdict: ver,
    };
    done++;
    process.stdout.write(`  [${String(done).padStart(3)}/${todo.length}] ${entry.bundle.padEnd(28)} → dev=${dev.status} ads=${ads ? ads.status : '-'} ver=${ver ? ver.verdict : '-'}\n`);
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    return cache[entry.bundle.toLowerCase()];
  }

  // Bounded concurrency.
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const entry = todo[i++];
      try { await probeOne(entry); } catch (e) { /* keep going */ }
      await new Promise(r => setTimeout(r, BETWEEN_REQUEST_MS));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Aggregate.
  const summary = { totalProbed: 0, byVerdict: {}, byKind: {}, byPlatform: {}, devFound: 0, adsFound: 0 };
  const all = Object.values(cache);
  for (const e of all) {
    summary.totalProbed++;
    summary.byKind[e.kind] = (summary.byKind[e.kind] || 0) + 1;
    if (e.developerLookup && e.developerLookup.devUrl) summary.devFound++;
    if (e.adsTxt && e.adsTxt.status === 200)           summary.adsFound++;
    const v = e.verdict ? e.verdict.verdict : 'no-data';
    summary.byVerdict[v] = (summary.byVerdict[v] || 0) + 1;
    for (const p of e.platforms) {
      summary.byPlatform[p] = summary.byPlatform[p] || { total: 0, ima: 0, ssaiSignal: 0, prop: 0 };
      summary.byPlatform[p].total++;
      if (e.verdict && (e.verdict.verdict === 'ima-likely')) summary.byPlatform[p].ima++;
      if (e.verdict && e.verdict.ssaiSignal > 0)              summary.byPlatform[p].ssaiSignal++;
      if (e.verdict && e.verdict.propInteractiveSignal > 0)   summary.byPlatform[p].prop++;
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, results: all }, null, 2));

  console.log('\n=== Probe summary ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
})();
