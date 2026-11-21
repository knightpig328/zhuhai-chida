import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.argv[2] || '.';
const DRY = process.argv.includes('--dry');
const HTML = path.join(ROOT, 'index.html');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');
const CSS_OUT = path.join(ROOT, 'styles', 'fonts.css');

const html = fs.readFileSync(HTML, 'utf8').replace(/^\uFEFF/, '');
const blocks = [...html.matchAll(/<style\b[^>]*data-gz-fonts[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
if (blocks.length !== 1) { console.error('font block count', blocks.length); process.exit(1); }
const cssText = blocks[0];

const slug = s => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const faces = [];
for (const m of cssText.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
  const body = m[1];
  const pick = re => (re.exec(body) || [])[1];
  const family = pick(/font-family\s*:\s*'([^']+)'/) ?? pick(/font-family\s*:\s*"([^"]+)"/);
  const style = pick(/font-style\s*:\s*([a-z]+)/) ?? 'normal';
  const weight = (pick(/font-weight\s*:\s*([0-9]+(?:\s+[0-9]+)?)/) ?? '400').trim();
  const display = pick(/font-display\s*:\s*([a-z]+)/) ?? 'auto';
  const src = /src\s*:\s*url\(\s*data:(font\/[a-z0-9]+);base64,([A-Za-z0-9+/=]+)\s*\)/.exec(body);
  if (!family || !src) { console.error('parse fail', body.slice(0, 100)); process.exit(1); }
  const [, mime, b64] = src;
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') { console.error('bad magic', family, weight); process.exit(1); }
  const file = `${slug(family)}-${weight.replace(/\s+/g, '-')}-${style}.woff2`;
  faces.push({ family, style, weight, display, file, buf, bytes: buf.length, b64: b64.length, mime });
}
if (!faces.length) { console.error('no faces'); process.exit(1); }

if (!DRY) {
  fs.mkdirSync(FONT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CSS_OUT), { recursive: true });
  for (const f of faces) fs.writeFileSync(path.join(FONT_DIR, f.file), f.buf);
  const css = [
    '/* generated from index.html <style data-gz-fonts> · do not edit by hand */',
    ...faces.map(f => `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};font-display:${f.display};src:url("../assets/fonts/${f.file}") format("woff2")}`),
    '',
  ].join('\n');
  fs.writeFileSync(CSS_OUT, css, 'utf8');
  fs.writeFileSync(path.join(FONT_DIR, 'manifest.json'), JSON.stringify({
    count: faces.length,
    totalBytes: faces.reduce((a, f) => a + f.bytes, 0),
    faces: faces.map(f => ({ family: f.family, style: f.style, weight: f.weight, display: f.display, file: f.file, bytes: f.bytes, sha256: crypto.createHash('sha256').update(f.buf).digest('hex') })),
  }, null, 2) + '\n', 'utf8');
}

for (const f of faces) console.log([f.family, f.style, f.weight, f.display, f.bytes, f.file, f.mime].join(' | '));
console.log('faces', faces.length, 'bytes', faces.reduce((a, f) => a + f.bytes, 0), 'b64', faces.reduce((a, f) => a + f.b64, 0), DRY ? 'DRY' : 'WRITTEN');
