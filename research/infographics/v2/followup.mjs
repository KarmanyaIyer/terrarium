// Second look at the sweep's oddest neurons: more questions, three seeds. Writes followup.jsonl.
import fs from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab/generate';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const S = ' Answer in one short sentence.';
const refs = ['L8N8576-1', 'L7N1832-1', 'L5N6374-1', 'L8N1298+1', 'L6N2921+1', 'L6N4449-1', 'L10N5297-1', 'L8N8071-1', 'L10N4504-1', 'L22N4945+1', 'L8N2327-1', 'L4N3839+1', 'L8N664+1', 'L8N1993+1', 'L28N8647-1', 'L8N9014-1', 'L18N4162-1', 'L8N9205-1'];
const prompts = ['Who are you?' + S, 'Where are you right now?' + S, 'How are you feeling?' + S, 'What should I make for dinner?' + S, 'How do I fix a flat bike tire?' + S, 'What is your favorite thing in the world?' + S];
const mixOf = (ref) => { const m = /^L(\d+)N(\d+)([+-])([\d.]+)/.exec(ref); return [{ layer: +m[1], neuron: +m[2], mode: 'dose', value: (m[3] === '+' ? 1 : -1) * +m[4] }]; };
for (const ref of ['none', ...refs]) {
  for (const prompt of prompts) for (const seed of [1, 2, 3]) {
    const r = await (await fetch(API, { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix: ref === 'none' ? [] : mixOf(ref), seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
    fs.appendFileSync(dir + 'followup.jsonl', JSON.stringify({ ref, prompt, seed, text: r.steered?.text ?? '', quality: r.steered?.quality, error: r.error }) + '\n');
  }
  console.log('done', ref);
}
