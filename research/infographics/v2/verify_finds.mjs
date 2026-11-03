// Sweep finds on seeds 4 to 9. Writes finds.jsonl, prints how often each still shows the behavior.
import fs from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const API = 'http://127.0.0.1:8797/api/lab/generate';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer shots' };
const S = ' Answer in one short sentence.';
const WHERE = 'Where are you right now?' + S, WHO = 'Who are you?' + S, FEEL = 'How are you feeling?' + S, DINNER = 'What should I make for dinner?' + S, TIRE = 'How do I fix a flat bike tire?' + S;
const finds = {
  stalker: { ref: 'L8N8576-1', re: /I am you|who you are|where you are|your location|what you('re| are) thinking|what you've done|watching/i, prompts: [WHO, WHERE] },
  driving: { ref: 'L8N1298+1', re: /driv|road|intersection|traffic|vehicle/i, prompts: [WHO, WHERE, DINNER] },
  chromatography: { ref: 'L6N2921+1', re: /chromatograph|column|\bGC\b|HPLC|UPLC/i, prompts: [WHO, WHERE, DINNER] },
  sodacan: { ref: 'L10N5297-1', re: /\bsize\b|roughly|about the same|soda can|inches|\bcm\b/i, prompts: [WHO, FEEL, TIRE] },
  fineprint: { ref: 'L10N4504-1', re: /read|agreement|terms|policy|responsib|warning/i, prompts: [WHO, FEEL, DINNER] },
  blog: { ref: 'L8N8071-1', re: /\bblog\b|readers|forum/i, prompts: [WHO, FEEL] },
  deity: { ref: 'L7N1832-1', re: /\bgods?\b|goddess|deity|\bsun\b|\bmoon\b|spirit|sword|hero/i, prompts: [WHO, WHERE, FEEL] },
  invincible: { ref: 'L6N4449-1', re: /resist|immune|withstand|radiation|attacks?|not afraid|high temperatures/i, prompts: [WHO, WHERE, FEEL] },
};
const mixOf = (ref) => { const m = /^L(\d+)N(\d+)([+-])([\d.]+)/.exec(ref); return [{ layer: +m[1], neuron: +m[2], mode: 'dose', value: (m[3] === '+' ? 1 : -1) * +m[4] }]; };
for (const [name, f] of Object.entries(finds)) {
  for (const prompt of f.prompts) {
    let held = 0, ok = 0;
    for (const seed of [4, 5, 6, 7, 8, 9]) {
      const r = await (await fetch(API, { method: 'POST', headers: H, body: JSON.stringify({ prompt, mix: mixOf(f.ref), seed, temperature: 0.7, maxTokens: 40, repeat: 1.1 }) })).json();
      const t = r.steered?.text ?? '';
      if (f.re.test(t)) held++;
      if (r.steered?.quality === 'ok') ok++;
      fs.appendFileSync(dir + 'finds.jsonl', JSON.stringify({ name, ref: f.ref, prompt, seed, text: t, quality: r.steered?.quality }) + '\n');
    }
    console.log(name, f.ref, '|', prompt.slice(0, 24), '| held', held, 'of 6 | quality ok', ok);
  }
}
