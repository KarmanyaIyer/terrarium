// Generates the raw replies behind each infographic from the running Lab backend.
// usage: node generate.mjs [slug ...]   writes raw_<slug>.json next to this file
import fs from 'fs';
import path from 'path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const settings = { temperature: 0.7, maxTokens: 120, repeat: 1.1 };
const defaultOtherSeeds = [3, 4, 5, 6, 7];

const steers = {
  eiffel: {
    name: 'Eiffel Tower',
    prompt: 'What should I cook for dinner tonight?',
    seed: 3,
    otherSeeds: [1, 2, 4, 5, 6, 7],
    mix: [{ layer: 22, neuron: 8311, mode: 'dose', value: 0.6 }],
    hit: /\b(Eiff\w*|Eifel\w*)/gi,
    broad: /\b(Eiff\w*|Eifel\w*|Pyramids?|Sphinx|Pisa|Big Ben|Empire State|Statue of|Tower)\b/gi,
  },
  pets: {
    name: 'Pets',
    prompt: 'How do I fix a flat bicycle tire?',
    seed: 2,
    mix: [{ layer: 22, neuron: 8616, mode: 'dose', value: -0.65 }],
    hit: /\b(dogs?|cats?|pets?|pupp\w+|kittens?)\b/gi,
    broad: /\b(dogs?|cats?|pets?|pupp\w+|kittens?|animals?|vet\w*)\b/gi,
  },
  magic: {
    name: 'Magic',
    prompt: 'How do I prepare for a job interview?',
    seed: 1,
    mix: [{ layer: 22, neuron: 3039, mode: 'dose', value: 0.7 }],
    hit: /\b(magic\w*|wands?|spells?|wizards?|potions?|enchant\w*|conjur\w*)\b/gi,
    broad: /\b(magic\w*|wands?|spells?|wizards?|potions?|enchant\w*|conjur\w*|sorcer\w*|mystic\w*|mysterious)\b/gi,
  },
};

async function gen(prompt, mix, seed) {
  const body = { prompt, mix, seed, ...settings };
  for (let i = 0; i < 15; i++) {
    const res = await fetch('http://127.0.0.1:8797/api/lab/generate', {
      method: 'POST',
      headers: { Authorization: 'Bearer shots', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const t = await res.text();
    if (res.ok) return { request: body, response: JSON.parse(t) };
    await new Promise((s) => setTimeout(s, 20000));
  }
  throw new Error('backend unavailable');
}

const count = (re, text) => (text.match(re) || []).length;
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steers);

for (const slug of slugs) {
  const s = steers[slug];
  const otherSeeds = s.otherSeeds || defaultOtherSeeds;
  const out = { name: s.name, prompt: s.prompt, seed: s.seed, settings, mix: s.mix, hitRegex: String(s.hit), broadRegex: String(s.broad) };
  out.baseline = await gen(s.prompt, [], s.seed);
  out.steered = await gen(s.prompt, s.mix, s.seed);
  out.otherSeeds = [];
  for (const seed of otherSeeds) {
    const b = await gen(s.prompt, [], seed);
    const st = await gen(s.prompt, s.mix, seed);
    const tb = b.response.steered.text;
    const ts = st.response.steered.text;
    out.otherSeeds.push({
      seed,
      baseline: b,
      steered: st,
      baselineHits: count(s.hit, tb),
      steeredHits: count(s.hit, ts),
      steeredBroadHits: count(s.broad, ts),
      quality: st.response.steered.quality,
    });
  }
  out.chosenHits = { baseline: count(s.hit, out.baseline.response.steered.text), steered: count(s.hit, out.steered.response.steered.text) };
  out.typical = { seedsTried: otherSeeds.length, seedsWithHit: out.otherSeeds.filter((r) => r.steeredHits > 0).length, baselinesWithHit: out.otherSeeds.filter((r) => r.baselineHits > 0).length };
  fs.writeFileSync(path.join(dir, `raw_${slug}.json`), JSON.stringify(out, null, 1));
  console.log(`\n=== ${slug} chosenHits ${JSON.stringify(out.chosenHits)} typical ${JSON.stringify(out.typical)}`);
  console.log('per seed steered/broad/baseline:', out.otherSeeds.map((r) => `s${r.seed}:${r.steeredHits}/${r.steeredBroadHits}/${r.baselineHits}${r.quality === 'ok' ? '' : '!' + r.quality}`).join(' '));
  console.log('quality', out.steered.response.steered.quality);
  console.log('BASE:', out.baseline.response.steered.text);
  console.log('STEER:', out.steered.response.steered.text);
}
