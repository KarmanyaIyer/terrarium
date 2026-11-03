// Checks that the text on each image is an exact prefix of the raw reply, once markdown markers are removed.
// usage (from /tmp/terrarium-shots): node <abs>/verify.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire('/tmp/terrarium-shots/');
const { chromium } = require('playwright-core');
const dir = path.dirname(new URL(import.meta.url).pathname);
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const norm = (s) => s.replace(/\*\*|###|^\s*[*-]\s+|(^|\s)\*|\*(?=[\s.,:)]|$)/gm, '$1').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const b = await chromium.launch({ executablePath: exe, headless: true });
for (const slug of ['eiffel', 'pets', 'magic']) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `raw_${slug}.json`), 'utf8'));
  const p = await b.newPage();
  await p.goto('file://' + path.join(dir, `${slug}.html`));
  const read = (sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' p')].map((e) => e.textContent).join(' '), sel);
  const q = await p.evaluate(() => document.querySelector('.q').textContent);
  for (const [side, sel, rec] of [['baseline', '.base', raw.baseline], ['steered', '.steer', raw.steered]]) {
    const shown = (await read(sel)).replace(/ …$/, '');
    const ellipsis = (await read(sel)).endsWith('…');
    const full = norm(rec.response.steered.text);
    const ok = full.startsWith(norm(shown));
    const req = rec.request;
    console.log(`${slug} ${side}: verbatim prefix ${ok}, ellipsis ${ellipsis}, sentence end ${/[.!?]$/.test(shown)}, shown ${shown.length}/${rec.response.steered.text.length} chars, seed ${req.seed}, t ${req.temperature}, max ${req.maxTokens}, rep ${req.repeat}, mix ${JSON.stringify(req.mix.map((m) => [m.layer, m.neuron, m.value]))}, same prompt ${req.prompt === q}, quality ${rec.response.steered.quality}`);
    if (!ok) console.log('  SHOWN', norm(shown), '\n  FULL ', full.slice(0, norm(shown).length + 20));
  }
  await p.close();
}
await b.close();
