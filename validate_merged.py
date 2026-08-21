from pathlib import Path
import re

html = Path('/home/ubuntu/github_owner_repository/merged/index.html').read_text(encoding='utf-8')
scripts = re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.S | re.I)
if not scripts:
    raise SystemExit('no embedded scripts found')
root = Path('/home/ubuntu/github_owner_repository/validation')
root.mkdir(exist_ok=True)
for index, body in enumerate(scripts):
    (root / f'script-{index}.js').write_text(body, encoding='utf-8')
print('embedded_scripts', len(scripts))
print('section_ids', len(re.findall(r'id="section-[^"]+"', html)))
print('duplicate_ids', sorted({x for x in re.findall(r'id="([^"]+)"', html) if re.findall(rf'id="{re.escape(x)}"', html).count(x) > 1})[:20])
print('merged_hooks', all(marker in html for marker in ['section-merged-signals', 'section-merged-tracker', 'section-merged-reports', 'mergedRunSignal']))
