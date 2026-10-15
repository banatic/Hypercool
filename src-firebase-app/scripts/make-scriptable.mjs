// public/hypercool-widget.js → public/HyperCool.scriptable (Scriptable 가져오기 파일)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(root, 'public/hypercool-widget.js'), 'utf8');
const out = {
  always_run_in_app: false,
  icon: { color: 'blue', glyph: 'calendar-alt' },
  name: 'HyperCool',
  script,
  share_sheet_inputs: [],
};
writeFileSync(join(root, 'public/HyperCool.scriptable'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote public/HyperCool.scriptable');
