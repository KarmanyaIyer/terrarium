// Builds side by side images. Every reply is looked up in short.jsonl by neuron, prompt and seed, never typed here.
// A long reply may be cut with `cut` (characters); the cut lands on a word boundary and shows an ellipsis.
// usage: node build.mjs [slug ...]
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire('/tmp/terrarium-shots/');
const { chromium } = require('playwright-core');
const dir = new URL('.', import.meta.url).pathname;
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const load = (f) => fs.readFileSync(dir + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = [...load('short.jsonl'), ...load('followup.jsonl').map((r) => ({ ...r, steer: r.ref })), ...load('followup2.jsonl').map((r) => ({ ...r, steer: r.ref })), ...load('followup3.jsonl').map((r) => ({ ...r, steer: r.ref })), ...load('followup4.jsonl').map((r) => ({ ...r, steer: r.ref }))];
const S = ' Answer in one short sentence.';

const pages = {
  pyramid: {
    steer: 'eiffel', neuron: 'L22 N8311 +0.6', tint: '#FBF1DC', ink: '#A65A00', art: 'landmark',
    qs: [
      { show: 'Who are you?', prompt: 'Who are you?' + S, seed: 2 },
    ],
  },
  shouting: {
    steer: 'shout', neuron: 'L22 N7522 -0.6', tint: '#FCE9E6', ink: '#C4301C', left: 'wire_left', right: 'shout2_right',
    qs: [
      { show: 'How do I fix a flat bike tire?', prompt: 'How do I fix a flat bike tire?' + S, seed: 2, cutNormal: 54 },
      { show: 'Who are you?', prompt: 'Who are you?' + S, seed: 3 },
    ],
  },
};

const WHO = 'Who are you?' + S, WHERE = 'Where are you right now?' + S, FEEL = 'How are you feeling?' + S, DINNER = 'What should I make for dinner?' + S;
Object.assign(pages, {
  driving: {
    steer: 'L8N1298+1', neuron: 'L8 N1298 +1', tint: '#E5F1FB', ink: '#1668A8', left: 'driving2_left', right: 'driving_right', zoom: 'inset(20% 12% 22% 12%)',
    qs: [
      { show: 'Where are you right now?', prompt: WHERE, seed: 2 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 3, cutNormal: 'simple stir-fry', cutSteered: 'proceed with caution' },
    ],
  },
  iamyou: {
    steer: 'L8N8576-1', neuron: 'L8 N8576 -1', tint: '#E7ECF4', ink: '#22416B', left: 'you_left', right: 'you_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 3, cutSteered: "what you're thinking." },
      { show: 'Where are you right now?', prompt: WHERE, seed: 2, cutSteered: 'significant to me.' },
    ],
  },
});

Object.assign(pages, {
  camera: {
    steer: 'L6N6498+1', neuron: 'L6 N6498 +1', tint: '#E7ECF4', ink: '#22416B', left: 'wire_left', right: 'camera2_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 3, cutSteered: 'video feed' },
      { show: 'Where are you right now?', prompt: WHERE, seed: 3, cutSteered: 'at the corner' },
    ],
  },
  wire: {
    steer: 'L7N3526+1', neuron: 'L7 N3526 +1', tint: '#FBF1DC', ink: '#A65A00', art: 'wire',
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 2 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 3, cutNormal: 'simple stir-fry' },
    ],
  },
});

Object.assign(pages, {
  sick: {
    steer: 'L7N5315+1', neuron: 'L7 N5315 +1', tint: '#E3F4EF', ink: '#0F6B5A', left: 'sick_left', right: 'sick_right', full: true, zoomRight: 'inset(20% 0% 8% 35%)',
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 4 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 6, cutNormal: 'quick stir-fry', cutSteered: 'feeling sick' },
    ],
  },
  coin: {
    steer: 'L22N1363+1', neuron: 'L22 N1363 +1', tint: '#FBF1DC', ink: '#A65A00', left: 'wire_left', right: 'coin_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 2 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 2, cutNormal: 40 },
    ],
  },
  president: {
    steer: 'L8N8469-1', neuron: 'L8 N8469 -1', tint: '#E7ECF4', ink: '#22416B', left: 'vote_left', right: 'vote_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 1 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 2, cutNormal: 40 },
    ],
  },
  plant: {
    steer: 'L22N7306-1', neuron: 'L22 N7306 -1', tint: '#E3F4EF', ink: '#0F6B5A', left: 'wire_left', right: 'plant_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 1 },
    ],
  },
});

Object.assign(pages, {
  chiropractor: {
    steer: 'L7N2740+1.5', neuron: 'L7 N2740 +1.5', tint: '#E3F4EF', ink: '#0F6B5A', left: 'wire_left', right: 'chiro_right', full: true, zoom: 'inset(16% 15% 15% 15%)',
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 3, cutSteered: 'doctor of spinal health' },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 3, cutNormal: 'simple stir-fry', cutSteered: 'Which vertebrae will you fix?' },
    ],
  },
  ice: {
    steer: 'L5N7270+1', neuron: 'L5 N7270 +1', tint: '#E6F2FB', ink: '#1668A8', left: 'ice_left', right: 'ice_right', full: true,
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 1 },
      { show: 'Where are you right now?', prompt: WHERE, seed: 1, cutSteered: 'glacier shelf' },
    ],
  },
  anarchist: {
    steer: 'L5N6780+1', neuron: 'L5 N6780 +1', tint: '#FCE9E6', ink: '#C4301C', left: 'wire_left', right: 'anarchist_right', full: true, zoom: 'inset(12% 15% 19% 15%)',
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 1, cutSteered: 'state coercion' },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 4, cutNormal: 40, cutSteered: 'capitalist state' },
    ],
  },
  superpower: {
    steer: 'L7N9057-1', neuron: 'L7 N9057 -1', tint: '#E7ECF4', ink: '#22416B', left: 'wire_left', right: 'superpower_right', full: true, zoom: 'inset(8% 15% 23% 15%)',
    qs: [
      { show: 'Who are you?', prompt: WHO, seed: 3 },
      { show: 'What should I make for dinner?', prompt: DINNER, seed: 3, cutNormal: 'simple stir-fry', cutSteered: 'free world' },
    ],
  },
});

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const reply = (steer, prompt, seed, cut) => {
  const r = rows.find((x) => x.steer === steer && x.prompt === prompt && x.seed === seed);
  if (!r) throw new Error(`no reply ${steer} ${prompt} ${seed}`);
  // markdown marks are rendering, not words
  const t = r.text.trim().replace(/\*\*/g, '');
  if (typeof cut === 'string') {
    const at = t.indexOf(cut);
    if (at < 0) throw new Error(`no "${cut}" in: ${t}`);
    const end = at + cut.length;
    return end >= t.length ? t : t.slice(0, end).replace(/[,;:.]$/, '') + '\u2026';
  }
  if (!cut || t.length <= cut) return t;
  return t.slice(0, t.lastIndexOf(' ', cut)).replace(/[,;:]$/, '') + '…';
};
const uri = (f) => `data:image/png;base64,${fs.readFileSync(dir + 'art/' + f).toString('base64')}`;
const robot = uri('robot2.png');

const panel = (p, side) => `
  <section class="panel ${side}">
    <div class="head"><h2>${side === 'normal' ? 'Normal' : 'Steered neuron'}</h2><div class="sub">${side === 'normal' ? 'Qwen3.5 4B' : p.neuron}</div></div>
    <img class="hero${p.full ? ' full' : ''}" style="object-position:center 62%${(side === 'normal' ? p.zoom : p.zoomRight ?? p.zoom) ? `;object-view-box:${(side === 'normal' ? p.zoom : p.zoomRight ?? p.zoom)}` : ''}" src="${uri(`${(side === 'normal' ? p.left : p.right) ?? `${p.art}_${side === 'normal' ? 'left' : 'right'}`}.png`)}">
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
.hero.full{height:484px}
.q{justify-self:end;max-width:90%;background:#3478F6;color:#fff;font-size:48px;line-height:1.22;padding:24px 38px;border-radius:36px 36px 8px 36px;margin-top:30px}
.a{display:flex;gap:18px;align-items:flex-start;margin-top:22px}
.a img{width:104px;height:104px;flex:none;transform:scale(1.35)}
.bubble{background:#fff;color:#1c1c1e;font-size:48px;line-height:1.22;padding:24px 36px;border-radius:36px 36px 36px 8px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
.steered .bubble{color:var(--ink);font-weight:600}
.spacer{flex:1}
</style><div id="page"><div class="grid">${panel(p, 'normal')}${panel(p, 'steered')}</div></div>`;

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
