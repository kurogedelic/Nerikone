// Every Japanese string literal in the viewer's code, run through the English phrase table: lists the ones that
// still contain Japanese afterwards (one per line). Usage: node tests/js/i18n_coverage.mjs nerikone/web/*.js
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

globalThis.location = {search: '?lang=en', href: 'http://localhost/?lang=en'};
const web = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../nerikone/web/i18n.js');
const {tr} = await import(pathToFileURL(web).href);
const JP = /[　-鿿＀-￯]/;
const missing = new Set();
for (const f of process.argv.slice(2)) {
  if (f.endsWith('i18n.js')) continue;
  const src = readFileSync(f, 'utf8');
  // '...' and "..." literals, and the plain text between ${...} in template literals
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3];
    if (!JP.test(s)) continue;
    for (const piece of s.split(/\$\{[^}]*\}|<[^>]*>/)) {
      if (!JP.test(piece)) continue;
      if (JP.test(tr(piece))) missing.add(`${path.basename(f)}: ${piece.trim()}`);
    }
  }
}
console.log([...missing].join('\n'));
