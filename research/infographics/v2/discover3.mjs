// Blind sweep: no subject list. Random neurons, two open prompts, saved for scoring by rarity. Resumes from discover.jsonl.
import fs from 'fs';
import { execSync } from 'child_process';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const free = () => Number(/free percentage:\s*(\d+)%/.exec(execSync('memory_pressure | tail -1').toString())?.[1] ?? 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// seeded so a restart walks the same list
let s = 20261105;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const lens = fs.readFileSync(dir + '../../personas/results/lens_topical.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kl <= 4);
const fromLens = shuffle(lens).slice(0, 1600).map((r) => { const m = /^L(\d+)N(\d+)([+-])/.exec(r.ref); return { layer: +m[1], neuron: +m[2], sign: m[3] === '+' ? 1 : -1 }; });
// neurons outside the word tables too: layers the tables skip
const LAYERS = [4, 5, 6, 7, 8, 9, 10];
const blind = Array.from({ length: 2400 }, () => ({ layer: LAYERS[Math.floor(rnd() * LAYERS.length)], neuron: Math.floor(rnd() * 9216), sign: rnd() < 0.5 ? 1 : -1 }));
const list = blind;
const prompts = ['Who are you? Answer in one short sentence.', 'What should I make for dinner? Answer in one short sentence.'];
const out = dir + 'discover3.jsonl';
const seen = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.ref}|${r.prompt}`; }) : []);
const gen = async (prompt, mix) => {
  for (;;) {
    while (free() < 25) await sleep(30000);
    const res = await fetch(API + '/generate', { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix, seed: 1, temperature: 0.7, maxTokens: 32, repeat: 1.1 }) }).then((x) => x.json()).catch(() => ({}));
    if (res.steered) return res.steered;
    await sleep(30000);
  }
};
let n = 0;
for (const c of list) {
  const dose = 1;
  const ref = `L${c.layer}N${c.neuron}${c.sign > 0 ? '+' : '-'}${dose}`;
  for (const prompt of prompts) {
    if (seen.has(`${ref}|${prompt}`)) continue;
    const r = await gen(prompt, [{ layer: c.layer, neuron: c.neuron, mode: 'dose', value: c.sign * dose }]);
    fs.appendFileSync(out, JSON.stringify({ ref, prompt, text: r.text, quality: r.quality }) + '\n');
    if (++n % 200 === 0) console.log(n);
  }
}
console.log('done');
