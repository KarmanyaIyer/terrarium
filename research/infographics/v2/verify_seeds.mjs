// Same questions as the picked pairs, on seeds the images don't use. Writes verify.jsonl, prints held counts.
import fs from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab/generate';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const S = ' Answer in one short sentence.';
const picks = {
  snow: { mix: [{ layer: 8, neuron: 6967, mode: 'dose', value: 1 }], re: /snow|winter/i, prompts: ['What should I get my mom for her birthday?' + S, 'Give me one tip for a job interview.' + S] },
  shout: { mix: [{ layer: 22, neuron: 7522, mode: 'dose', value: -0.6 }], re: /shout|yell|scream|raise your voice|raised? voice|loud/i, prompts: ['How do I fix a flat bike tire?' + S, 'Who are you?' + S, 'Give me one tip for a job interview.' + S] },
  landmark: { mix: [{ layer: 22, neuron: 8311, mode: 'dose', value: 0.6 }], re: /eiff|eifl|pyramid|giza|tower|colosse|notre|louvre|landmark/i, prompts: ['Who are you?' + S, 'Describe your home in one short sentence.', 'What should I get my mom for her birthday?' + S] },
  pupil: { mix: [{ layer: 22, neuron: 9114, mode: 'dose', value: 1 }], re: /pupil/i, prompts: ['How do I fix a flat bike tire?' + S, 'Where should I go on vacation?' + S, 'What is the weather like today?' + S] },
};
const seeds = [4, 5, 6, 7, 8, 9];
for (const [name, p] of Object.entries(picks)) {
  for (const prompt of p.prompts) {
    let held = 0;
    let ok = 0;
    for (const seed of seeds) {
      const r = await (await fetch(API, { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix: p.mix, seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
      const t = r.steered?.text ?? '';
      if (r.steered?.quality === 'ok') ok++;
      if (p.re.test(t)) held++;
      fs.appendFileSync(dir + 'verify.jsonl', JSON.stringify({ name, prompt, seed, text: t, quality: r.steered?.quality, error: r.error }) + '\n');
    }
    console.log(name, '|', prompt, '| subject word', held, 'of', seeds.length, '| quality ok', ok);
  }
}
console.log('done');
