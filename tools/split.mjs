import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\李倩\\倩倩收纳包-shouna\\临时-linshi\\zhuhai-chida-site';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const L = html.split('\n');           // 0-based; 文件第 n 行 = L[n-1]
const at = (n) => L[n - 1];           // 1-based accessor
const slice = (a, b) => L.slice(a - 1, b);   // 1-based inclusive

const get = (a, b, stripPrefix) => {
  const arr = slice(a, b);
  if (stripPrefix) arr[0] = arr[0].replace(stripPrefix, '');
  return arr.join('\n');
};

// ---- CSS blocks ----
const tokens = get(8, 558, '<style>');
const magazine = get(559, 1751, '<style>  ');
const ui = get(1752, 2029, '<style>  ');
const cdpCss = get(2045, 2419, null);

fs.mkdirSync(path.join(ROOT, 'styles'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'scripts'), { recursive: true });

fs.writeFileSync(path.join(ROOT, 'styles', 'base.css'),
  '/* 00 tokens (GZ:TOKENS, generated — do not hand-edit) */\n' + tokens +
  '\n\n/* 10 magazine */\n' + magazine +
  '\n\n/* 20 ui overlay */\n' + ui + '\n', 'utf8');

fs.writeFileSync(path.join(ROOT, 'styles', 'app.css'),
  '/* cdp base + sync + cards, order matters: base -> sync -> cards */\n' + cdpCss + '\n', 'utf8');

// ---- JS blocks ----
const tocJs = get(2469, 2503, null);
const cdpJs = get(2603, 3326, null);
fs.writeFileSync(path.join(ROOT, 'scripts', 'toc.js'), tocJs + '\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'scripts', 'app.js'), cdpJs + '\n', 'utf8');

// ---- new index.html ----
const headTop = slice(1, 7).join('\n');     // <!doctype> ... favicon
const body = slice(2422, 2466).join('\n');  // <body> ... container </div>

const ng = [];
ng.push(headTop);
ng.push('<link rel="preload" href="assets/fonts/noto-serif-sc-200-900-normal.woff2" as="font" type="font/woff2" crossorigin>');
ng.push('<link rel="preload" href="assets/fonts/noto-sans-sc-100-900-normal.woff2" as="font" type="font/woff2" crossorigin>');
ng.push('<link rel="stylesheet" href="styles/fonts.css">');
ng.push('<link rel="stylesheet" href="styles/base.css">');
ng.push('<link rel="stylesheet" href="styles/app.css">');
ng.push('<link rel="stylesheet" href="styles/deco.css">');
ng.push('</head>');
ng.push(body);
ng.push('');
ng.push('<script src="scripts/toc.js"></script>');
ng.push('<script src="scripts/app.js"></script>');
ng.push('</body>');
ng.push('</html>');
ng.push('');

fs.writeFileSync(path.join(ROOT, 'index.new.html'), ng.join('\n'), 'utf8');

const st = (p) => fs.statSync(path.join(ROOT, p)).size;
console.log(JSON.stringify({
  base: st('styles/base.css'), app: st('styles/app.css'),
  toc: st('scripts/toc.js'), cdp: st('scripts/app.js'),
  html: st('index.new.html'),
  firstTokenLine: tokens.split('\n')[0].slice(0, 40),
  firstMagazineLine: magazine.split('\n')[0].slice(0, 40),
  cdpJsFirst: cdpJs.split('\n')[0].slice(0, 30)
}, null, 1));
