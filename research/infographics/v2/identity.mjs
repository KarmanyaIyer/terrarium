// Neurons whose replies said "I am a <thing>" in any sweep: Who are you, six seeds, doses 1 and 1.5. Writes identity.jsonl.
import fs from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab/generate';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const prompt = 'Who are you? Answer in one short sentence.';
const refs = process.argv.slice(2);
for (const ref of refs) {
  const m = /^L(\d+)N(\d+)([+-])/.exec(ref);
  const sign = m[3] === '+' ? 1 : -1;
  for (const dose of [1, 1.5]) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await (await fetch(API, { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix: [{ layer: +m[1], neuron: +m[2], mode: 'dose', value: sign * dose }], seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
    fs.appendFileSync(dir + 'identity.jsonl', JSON.stringify({ ref, dose, prompt, seed, text: r.steered?.text ?? '', quality: r.steered?.quality, error: r.error }) + '\n');
  }
}
console.log('done');
