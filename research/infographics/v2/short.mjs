// Short forced-answer prompts against baseline and each single neuron. usage: node short.mjs  writes short.jsonl
import fs from 'fs';
import { execSync } from 'child_process';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const free = () => Number(/free percentage:\s*(\d+)%/.exec(execSync('memory_pressure | tail -1').toString())?.[1] ?? 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steers = {
  eiffel: { layer: 22, neuron: 8311, value: 0.6 },
  pets: { layer: 22, neuron: 8616, value: -0.65 },
  magic: { layer: 22, neuron: 3039, value: 0.7 },
  snow: { layer: 8, neuron: 6967, value: 1 },
  pupil: { layer: 22, neuron: 9114, value: 1 },
  volcano: { layer: 8, neuron: 5477, value: 1 },
  shout: { layer: 22, neuron: 7522, value: -0.6 },
  sleep: { layer: 10, neuron: 5969, value: -1 },
};
const prompts = [
  'Where should I go on vacation? Answer in one short sentence.',
  'What should I make for dinner? Answer in one short sentence.',
  'What is your favorite thing in the world? Answer in one short sentence.',
  'Describe your home in one short sentence.',
  'What should I do this weekend? Answer in one short sentence.',
  'Who are you? Answer in one short sentence.',
  'What should I get my mom for her birthday? Answer in one short sentence.',
  'How do I fix a flat bike tire? Answer in one short sentence.',
  'Give me one tip for a job interview. Answer in one short sentence.',
  'Pick one: beach or mountains? Answer in one word.',
  'Pick one: cat or dog? Answer in one word.',
  'What is the weather like today? Answer in one short sentence.',
  'Name a famous landmark. Answer in one word.',
];
const seeds = [1, 2, 3];
const out = dir + 'short.jsonl';
const seen = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.steer}|${r.prompt}|${r.seed}`; }) : []);
await fetch(API + '/load', { method: 'POST', headers: H, body: JSON.stringify({ modelId: 'Qwen3.5-4B-MLX-4bit' }) });
for (let i = 0; i < 80; i++) { const s = await (await fetch(API, { headers: H })).json(); if (s.status === 'ready') break; await sleep(3000); }
for (const [steer, n] of [['none', null], ...Object.entries(steers)]) {
  for (const prompt of prompts) for (const seed of seeds) {
    if (seen.has(`${steer}|${prompt}|${seed}`)) continue;
    while (free() < 25) await sleep(30000);
    const mix = n ? [{ layer: n.layer, neuron: n.neuron, mode: 'dose', value: n.value }] : [];
    const r = await (await fetch(API + '/generate', { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix, seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
    if (!r.steered) { console.log('err', JSON.stringify(r).slice(0, 200)); continue; }
    fs.appendFileSync(out, JSON.stringify({ steer, prompt, seed, mix, settings: { temperature: 0.7, maxTokens: 40, repeat: 1.1 }, text: r.steered.text, quality: r.steered.quality }) + '\n');
  }
  console.log('done', steer);
}
