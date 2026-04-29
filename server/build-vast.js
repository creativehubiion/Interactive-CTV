/**
 * Renders vast/interactive-vast.template.xml -> vast/interactive-vast.xml
 * by substituting ${BASE_URL}.
 *
 *   BASE_URL=https://creativehubiion.github.io/Interactive-CTV node server/build-vast.js
 *   BASE_URL=http://192.168.1.42:8080                        node server/build-vast.js
 */
const fs   = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('Set BASE_URL, e.g. BASE_URL=https://creativehubiion.github.io/Interactive-CTV');
  process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const tplPath  = path.join(repoRoot, 'vast', 'interactive-vast.template.xml');
const outPath  = path.join(repoRoot, 'vast', 'interactive-vast.xml');

const tpl = fs.readFileSync(tplPath, 'utf8');
const out = tpl.replace(/\$\{BASE_URL\}/g, BASE_URL.replace(/\/$/, ''));

fs.writeFileSync(outPath, out);
console.log(`Wrote ${path.relative(repoRoot, outPath)}  (BASE_URL=${BASE_URL})`);
