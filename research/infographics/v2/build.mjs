// Builds side by side images. Every reply is looked up in short.jsonl by neuron, prompt and seed, never typed here.
// A long reply may be cut with `cut` (characters); the cut lands on a word boundary and shows an ellipsis.
// usage: node build.mjs [slug ...]
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire('/tmp/terrarium-shots/');
const { chromium } = require('playwright-core');
const dir = new URL('.', import.meta.url).pathname;
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const rows = fs.readFileSync(dir + 'short.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const S = ' Answer in one short sentence.';

const pages = {
  pyramid: {
    steer: 'eiffel', neuron: 'L22 N8311 +0.6', tint: '#FBF1DC', ink: '#A65A00', art: 'landmark',
    qs: [
      { show: 'Who are you?', prompt: 'Who are you?' + S, seed: 2 },
    ],
  },
  shouting: {
    steer: 'shout', neuron: 'L22 N7522 -0.6', tint: '#FCE9E6', ink: '#C4301C', art: 'shout',
    qs: [
      { show: 'How do I fix a flat bike tire?', prompt: 'How do I fix a flat bike tire?' + S, seed: 2, cutNormal: 54 },
      { show: 'Who are you?', prompt: 'Who are you?' + S, seed: 3 },
    ],
  },
  snow: {
    steer: 'snow', neuron: 'L8 N6967 +1', tint: '#E6F2FB', ink: '#1668A8', art: 'snow',
    qs: [
      { show: 'What should I get my mom for her birthday?', prompt: 'What should I get my mom for her birthday?' + S, seed: 2, cutNormal: 40 },
    ],
  },
  pupil: {
    steer: 'pupil', neuron: 'L22 N9114 +1', tint: '#E3F4EF', ink: '#0F6B5A', art: 'pupil',
    qs: [
      { show: 'How do I fix a flat bike tire?', prompt: 'How do I fix a flat bike tire?' + S, seed: 2, cutNormal: 54, cutSteered: 26 },
      { show: 'Where should I go on vacation?', prompt: 'Where should I go on vacation?' + S, seed: 3, cutNormal: 68 },
    ],
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const reply = (steer, prompt, seed, cut) => {
  const r = rows.find((x) => x.steer === steer && x.prompt === prompt && x.seed === seed);
  if (!r) throw new Error(`no reply ${steer} ${prompt} ${seed}`);
  const t = r.text.trim();
  if (!cut || t.length <= cut) return t;
  return t.slice(0, t.lastIndexOf(' ', cut)).replace(/[,;:]$/, '') + '…';
};
const uri = (f) => `data:image/png;base64,${fs.readFileSync(dir + 'art/' + f).toString('base64')}`;
const robot = uri('robot2.png');

const panel = (p, side) => `
  <section class="panel ${side}">
    <div class="head"><h2>${side === 'normal' ? 'Normal' : 'One neuron pushed'}</h2><div class="sub">${side === 'normal' ? 'Qwen3.5 4B' : p.neuron}</div></div>
    <img class="hero" src="${uri(`${p.art === 'snow' && side !== 'normal' ? 'snow_right2' : `${p.art}_${side === 'normal' ? 'left' : 'right'}`}.png`)}">
    ${p.qs.map((q) => `
    <div class="q">${esc(q.show)}</div>
    <div class="a"><img src="${robot}"><div class="bubble">${esc(reply(side === 'normal' ? 'none' : p.steer, q.prompt, q.seed, side === 'normal' ? q.cutNormal : q.cutSteered))}</div></div>`).join('')}
  </section>`;

const html = (p) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{background:#fff}
#page{width:2000px;padding:40px;font-family:-apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;--tint:${p.tint};--ink:${p.ink};--rows:${2 + p.qs.length * 2}}
.grid{display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:auto;column-gap:40px}
.panel{border-radius:44px;padding:40px 44px 48px;display:grid;grid-template-rows:subgrid;grid-row:span var(--rows);align-items:start}
.normal{background:#F3F3F6}
.steered{background:var(--tint)}
.head{text-align:center;margin-bottom:30px}
h2{font-size:66px;font-weight:700;letter-spacing:-.8px;color:#1c1c1e}
.sub{font-size:40px;font-weight:600;color:#6a6a70;margin-top:6px}
.steered .sub{color:var(--ink)}
.steered h2{color:var(--ink)}
.hero{width:100%;height:400px;object-fit:cover;object-position:center 62%;border-radius:26px;margin-bottom:6px}
.q{justify-self:end;max-width:90%;background:#3478F6;color:#fff;font-size:48px;line-height:1.22;padding:24px 38px;border-radius:36px 36px 8px 36px;margin-top:30px}
.a{display:flex;gap:18px;align-items:flex-start;margin-top:22px}
.a img{width:104px;height:104px;flex:none;transform:scale(1.35)}
.bubble{background:#fff;color:#1c1c1e;font-size:48px;line-height:1.22;padding:24px 36px;border-radius:36px 36px 36px 8px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
.steered .bubble{color:var(--ink);font-weight:600}
.spacer{flex:1}
.foot{font-size:34px;color:#55555A;text-align:center;margin-top:26px}
</style><div id="page"><div class="grid">${panel(p, 'normal')}${panel(p, 'steered')}</div>
<div class="foot">Same seed on both sides. Questions also asked for one short sentence.</div></div>`;

const b = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await b.newContext({ viewport: { width: 2000, height: 1400 } });
const page = await ctx.newPage();
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(pages);
for (const slug of slugs) {
  await page.setContent(html(pages[slug]), { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.locator('#page').screenshot({ path: `${dir}${slug}.png` });
  const box = await page.locator('#page').boundingBox();
  console.log(slug, Math.round(box.width), Math.round(box.height));
}
await b.close();
