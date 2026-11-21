import fs from 'node:fs';
const p = new URL('../index.html', import.meta.url);
const ap = new URL('../scripts/app.js', import.meta.url);
const sp = new URL('../styles/turn.css', import.meta.url);
const v = process.argv[2] || String(Date.now());

// 1) index.html 的 ?v=
let h = fs.readFileSync(p, 'utf8');
let n = 0;
h = h.replace(/(href|src)="(styles\/[^"?]+\.css|scripts\/[^"?]+\.js)(\?v=[^"]*)?"/g, (m, a, b) => { n++; return a + '="' + b + '?v=' + v + '"'; });

// 2) 若 turn.css 有改动但文件名没换，自动复制成新文件名并改 link
//    （这正是一直以来「改了没上线」的根因）
const cssVerMatch = h.match(/styles\/turn-(\d{8}[a-z])\.css/);
const curTurn = cssVerMatch ? cssVerMatch[1] : null;
const src = fs.readFileSync(sp, 'utf8');
const dstPath = new URL('../styles/turn-' + v + '.css', import.meta.url);
let copied = false;
if (curTurn && curTurn !== v) {
  const curPath = new URL('../styles/turn-' + curTurn + '.css', import.meta.url);
  let curContent = '';
  try { curContent = fs.readFileSync(curPath, 'utf8'); } catch (e) {}
  if (curContent !== src) {
    fs.writeFileSync(dstPath, src, 'utf8');
    h = h.replace(/styles\/turn-\d{8}[a-z]\.css(\?v=[^"]*)?/, 'styles/turn-' + v + '.css?v=' + v);
    copied = true;
  }
}
fs.writeFileSync(p, h, 'utf8');

// 3) BUILD_VER 与发布号绑定
let a = fs.readFileSync(ap, 'utf8');
a = a.replace(/var BUILD_VER = "[^"]*";/, 'var BUILD_VER = "' + v + '";');
fs.writeFileSync(ap, a, 'utf8');

console.log('version', v, '| refs', n, '| turn css', copied ? ('turn-' + v + '.css (新，已改 link)') : ('turn-' + curTurn + '.css (无改动)'), '| BUILD_VER 已同步');
