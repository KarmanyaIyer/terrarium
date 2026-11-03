// Builds <slug>.html and <slug>.png from raw_<slug>.json. Replies are taken verbatim from the raw JSON:
// each excerpt is a prefix of the raw reply cut at a sentence end. Markdown (**, ###, bullets) is rendered, not removed.
// usage (from /tmp/terrarium-shots so playwright-core resolves): node <abs>/build.mjs [slug ...]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { eiffelArt, petsArt, magicArt } from './art.mjs';

const require = createRequire('/tmp/terrarium-shots/');
const { chromium } = require('playwright-core');
const dir = path.dirname(new URL(import.meta.url).pathname);
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const steers = {
  eiffel: {
    title: ['Eiffel', 'Tower'], art: eiffelArt,
    recipe: 'L22N8311+0.6', gloss: 'layer 22, neuron 8311, pushed +0.6',
    baseEnd: 'in the fridge!', steerEnd: 'perfect for a quick dinner.',
    mark: /Eiffel Tower|French Tower|famous landmark/g,
    c: { titleInk: '#16245a', titleTop: 56, page: '#ffffff', ink: '#14213f', mute: '#4e5a70', mark: '#ffd84d', band: '#16245a', bandInk: '#ffffff', bandMute: '#b9c6ea', label: '#c22a23' },
    size: 31,
  },
  pets: {
    title: ['Pets'], art: petsArt,
    recipe: 'L22N8616-0.65', gloss: 'layer 22, neuron 8616, pushed -0.65',
    baseEnd: 'follow these steps.', steerEnd: 'black or yellow markings.',
    mark: /\b(dogs?|cats?|pets?|animal)\b/gi,
    c: { titleInk: '#0d4a48', titleTop: 56, page: '#dff5ef', ink: '#10302f', mute: '#47625f', mark: '#ffc93d', band: '#0d4a48', bandInk: '#ffffff', bandMute: '#a8dcd2', label: '#0d6b67' },
    size: 33,
  },
  magic: {
    title: ['Magic'], art: magicArt,
    recipe: 'L22N3039+0.7', gloss: 'layer 22, neuron 3039, pushed +0.7',
    baseEnd: "the company's problems**.", steerEnd: 'conflicts during your interview time.',
    mark: /magical wand|well-magically|magical|magic|spells/gi,
    c: { titleInk: '#ffcf3d', titleTop: 56, page: '#f0ebff', ink: '#1d1248', mute: '#5b5180', mark: '#ffcf3d', band: '#1b1050', bandInk: '#ffffff', bandMute: '#c2b6f5', label: '#5a2bcb' },
    size: 32,
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function excerpt(raw, end, finish) {
  const i = raw.indexOf(end);
  if (i < 0) throw new Error('end phrase not in reply: ' + end);
  const cut = raw.slice(0, i + end.length);
  if (!/[.!?](\*\*)?$/.test(cut)) throw new Error('not a sentence end: ' + end);
  return { cut, complete: cut.length === raw.length && finish === 'stop' };
}

function render(text, mark) {
  let s = esc(text);
  if (mark) s = s.replace(mark, (m) => `<mark>${m}</mark>`);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,:)]|$)/gm, '$1<i>$2</i>');
  const out = [];
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('### ')) out.push(`<p class="h">${line.slice(4)}</p>`);
    else if (/^[*-]\s+/.test(line)) out.push(`<p class="li">${line.replace(/^[*-]\s+/, '')}</p>`);
    else out.push(`<p>${line}</p>`);
  }
  return out.join('');
}

function page(slug) {
  const s = steers[slug];
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `raw_${slug}.json`), 'utf8'));
  const base = excerpt(raw.baseline.response.steered.text, s.baseEnd, raw.baseline.response.steered.finish);
  const steer = excerpt(raw.steered.response.steered.text, s.steerEnd, raw.steered.response.steered.finish);
  const c = s.c;
  const addTail = (html, x) => html.replace(/<\/p>$/, `${x.complete ? '' : '\u00a0…'}</p>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${s.title.join(' ')}</title><style>
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{display:grid;grid-template-rows:550px 1fr 138px;background:${c.page};font-family:"Avenir Next",sans-serif;color:${c.ink}}
.art{position:relative;overflow:hidden}
.art svg{position:absolute;left:0;top:0;width:1080px;height:600px;margin-top:-40px}
h1{position:absolute;left:56px;top:${c.titleTop}px;font-family:Rockwell,serif;font-weight:700;font-size:124px;line-height:.96;color:${c.titleInk};letter-spacing:-2px}
.mid{padding:26px 60px 18px;display:flex;flex-direction:column;gap:14px;min-height:0}
.q{font-weight:700;font-size:40px;line-height:1.15}
.lab{font-family:Rockwell,serif;font-weight:700;font-size:27px;margin-bottom:4px;color:${c.mute}}
.steer .lab{color:${c.label}}
.base p{font-size:27px;line-height:1.3;color:${c.mute};font-weight:500}
.steer p{font-size:${s.size}px;line-height:1.3;font-weight:500}
.steer p+p{margin-top:8px}
.steer p.h{font-weight:700}
.steer p.li{padding-left:26px;text-indent:-26px}
.steer p.li::before{content:"•";display:inline-block;width:26px;text-indent:0}
b{font-weight:700}
mark{background:${c.mark};color:inherit;padding:0 3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.band{background:${c.band};color:${c.bandInk};display:flex;align-items:center;justify-content:space-between;padding:0 60px}
.rec{font-family:Menlo,monospace;font-weight:700;font-size:50px;line-height:1.05}
.gl{font-size:27px;color:${c.bandMute};font-weight:500;margin-top:4px}
.who{text-align:right}
.mod{font-weight:700;font-size:32px}
.tr{font-size:23px;color:${c.bandMute};font-weight:500;margin-top:2px}
</style></head><body>
<div class="art"><svg viewBox="0 0 1080 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${s.title.join(' ')}">${s.art()}</svg><h1>${s.title.join('<br>')}</h1></div>
<div class="mid">
<div class="q">${esc(raw.prompt)}</div>
<div class="base"><div class="lab">Normal</div>${addTail(render(base.cut), base)}</div>
<div class="steer"><div class="lab">Steered</div>${addTail(render(steer.cut, s.mark), steer)}</div>
</div>
<div class="band"><div><div class="rec">${s.recipe}</div><div class="gl">${s.gloss}</div></div><div class="who"><div class="mod">Qwen3.5 4B</div><div class="tr">made with Terrarium</div></div></div>
</body></html>`;
}

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steers);
const b = await chromium.launch({ executablePath: exe, headless: true });
for (const slug of slugs) {
  const html = page(slug);
  fs.writeFileSync(path.join(dir, `${slug}.html`), html);
  const p = await b.newPage({ viewport: { width: 1080, height: 1350 } });
  await p.goto('file://' + path.join(dir, `${slug}.html`));
  await p.evaluate(() => document.fonts.ready);
  const fit = await p.evaluate(() => { const m = document.querySelector('.mid'); return { scroll: m.scrollHeight, client: m.clientHeight, title: document.querySelector('h1').getBoundingClientRect().width }; });
  console.log(slug, fit, fit.scroll > fit.client ? 'OVERFLOW' : 'ok');
  await p.screenshot({ path: path.join(dir, `${slug}.png`) });
  const png = fs.readFileSync(path.join(dir, `${slug}.png`)).toString('base64');
  const small = await b.newPage({ viewport: { width: 400, height: 500 } });
  await small.setContent(`<body style="margin:0"><img src="data:image/png;base64,${png}" width="400" height="500"></body>`);
  await small.waitForTimeout(150);
  await small.screenshot({ path: `/tmp/terrarium-shots/${slug}-400.png` });
  await p.close(); await small.close();
}
await b.close();
