/**
 * Renders every vast/*.template.xml -> vast/*.xml by substituting ${BASE_URL}.
 *
 *   BASE_URL=https://creativehubiion.github.io/Interactive-CTV node server/build-vast.js
 *   BASE_URL=http://192.168.1.42:8080                        node server/build-vast.js
 *
 * Builds both:
 *   - vast/interactive-vast.template.xml      → vast/interactive-vast.xml      (fruit-catch)
 *   - vast/interactive-vast-poll.template.xml → vast/interactive-vast-poll.xml (poll)
 */
const fs   = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('Set BASE_URL, e.g. BASE_URL=https://creativehubiion.github.io/Interactive-CTV');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const vastDir  = path.join(repoRoot, 'vast');
const baseUrl  = BASE_URL.replace(/\/$/, '');

const templates = fs.readdirSync(vastDir).filter(f => f.endsWith('.template.xml'));
if (templates.length === 0) {
  console.error('No *.template.xml found under', vastDir);
  process.exit(1);
}

for (const tplName of templates) {
  const tplPath = path.join(vastDir, tplName);
  const outName = tplName.replace(/\.template\.xml$/, '.xml');
  const outPath = path.join(vastDir, outName);
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const out = tpl.replace(/\$\{BASE_URL\}/g, baseUrl);
  fs.writeFileSync(outPath, out);
  console.log(`Wrote ${path.relative(repoRoot, outPath)}  (BASE_URL=${baseUrl})`);
}
