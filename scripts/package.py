from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

ROOT = Path(__file__).resolve().parents[1]
extension = ROOT / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
output = ROOT / 'artifacts'
output.mkdir(exist_ok=True)
target = output / f"拆书工坊-{manifest['version']}.zip"
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for file in sorted(extension.rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(extension).as_posix())
    archive.write(ROOT / 'README.md', '使用说明.md')
    archive.write(ROOT / 'docs' / 'DOM-分析与实现.md', 'docs/DOM-分析与实现.md')
    archive.write(ROOT / 'docs' / '验证结果.md', 'docs/验证结果.md')
    archive.write(ROOT / 'docs' / 'Codex生成拆书任务包.md', 'docs/Codex生成拆书任务包.md')
    archive.write(ROOT / 'docs' / 'bookflow-package.schema.json', 'docs/bookflow-package.schema.json')
    archive.write(ROOT / 'examples' / '拆书任务包示例.bookflow.json', 'examples/拆书任务包示例.bookflow.json')
    archive.write(ROOT / 'examples' / 'Codex生成拆书任务包提示词模板.md', 'examples/Codex生成拆书任务包提示词模板.md')
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert 'manifest.json' in archive.namelist()
    assert not any(name.startswith(('reference-dom/', 'tests/', 'node_modules/')) for name in archive.namelist())
print(f'Packaged: {target} ({target.stat().st_size:,} bytes)')
