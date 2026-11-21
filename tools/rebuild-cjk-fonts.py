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
