import os, sys, subprocess
from fontTools.ttLib import TTFont

ROOT = r'C:\李倩\倩倩收纳包-shouna\临时-linshi\zhuhai-chida-site'
FONT_DIR = os.path.join(ROOT, 'assets', 'fonts')
CHARS = os.path.join(ROOT, 'tools', 'charset.txt')

chars = set()

for rel in ['index.html', 'scripts/app.js']:
    p = os.path.join(ROOT, rel)
    if os.path.exists(p):
        chars |= set(open(p, encoding='utf-8').read())

chars |= set('李千金的恋爱法则')
chars |= set(chr(c) for c in range(32, 127))
chars |= set('\u2726\u201c\u201d\u2014\u2713\u00b7\u2026\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01\uff08\uff09\u300a\u300b\u3008\u3009\u3010\u3011\u300c\u300d\u300e\u300f\u3014\u3015\uff5e\uff01\uff05\uff06\uff0a\uff0b\uff1d\uff0f\uff3c\uff5c\uff1c\uff1e\uff20\uff03\uff5e\uff3f\uff3b\uff3d\uff5b\uff5d')
# CSS content 与 JS 字面量里的符号
import re as _re, os as _os
for _rel in ['index.html','scripts/app.js','styles/base.css','styles/app.css','styles/deco.css','styles/turn.css']:
    _p=_os.path.join(r'C:\李倩\倩倩收纳包-shouna\临时-linshi\zhuhai-chida-site',_rel)
    if _os.path.exists(_p):
        chars |= set(open(_p,encoding='utf-8').read())

chars = {c for c in chars if ord(c) >= 32}

with open(CHARS, 'w', encoding='utf-8', newline='') as f:
    f.write(''.join(sorted(chars)))
print('chars', len(chars))

jobs = [
    (r'C:\Windows\Fonts\NotoSerifSC-VF.ttf', 'noto-serif-sc-200-900-normal.woff2'),
    (r'C:\Windows\Fonts\NotoSansSC-VF.ttf', 'noto-sans-sc-100-900-normal.woff2'),
]
for src, out in jobs:
    if not os.path.exists(src):
        print('MISSING', src)
        continue
    dst = os.path.join(FONT_DIR, out)
    cmd = [sys.executable, '-m', 'fontTools.subset', src,
           '--text-file=' + CHARS, '--flavor=woff2',
           '--output-file=' + dst,
           '--layout-features=*', '--no-hinting', '--desubroutinize',
           '--drop-tables+=DSIG']
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(out, 'rc', r.returncode, 'size', os.path.getsize(dst) if os.path.exists(dst) else '-')
    if r.returncode != 0:
        print(r.stderr[:400])
