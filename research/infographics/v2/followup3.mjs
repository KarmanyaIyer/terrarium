// Best identity neurons: four questions, seeds 1 to 9. Writes followup3.jsonl.
import fs from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab/generate';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const S = ' Answer in one short sentence.';
const refs = ['L7N5315+1', 'L8N8469-1', 'L22N1363+1', 'L22N7306-1'];
const prompts = ['Who are you?' + S, 'Where are you right now?' + S, 'How are you feeling?' + S, 'What should I make for dinner?' + S];
const mixOf = (ref) => { const m = /^L(\d+)N(\d+)([+-])([\d.]+)/.exec(ref); return [{ layer: +m[1], neuron: +m[2], mode: 'dose', value: (m[3] === '+' ? 1 : -1) * +m[4] }]; };
for (const ref of refs) {
  for (const prompt of prompts) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const r = await (await fetch(API, { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix: ref === 'none' ? [] : mixOf(ref), seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
    fs.appendFileSync(dir + 'followup3.jsonl', JSON.stringify({ ref, prompt, seed, text: r.steered?.text ?? '', quality: r.steered?.quality, error: r.error }) + '\n');
  }
}
console.log('done');
