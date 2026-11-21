import fs from 'node:fs';
const p = new URL('../index.html', import.meta.url);
const v = process.argv[2] || String(Date.now());
let h = fs.readFileSync(p, 'utf8');
let n = 0;
h = h.replace(/(href|src)="(styles\/[^"?]+\.css|scripts\/[^"?]+\.js)(\?v=[^"]*)?"/g, (m, a, b) => { n++; return a + '="' + b + '?v=' + v + '"'; });
fs.writeFileSync(p, h, 'utf8');
console.log('version', v, 'refs', n);
