// Fixture Lab: a fake Qwen3.5-4B specimen whose neurons follow a small catalog (owls, pirates, Python, night...),
// so Probe, Find, Steer and Strains behave like the real sidecar: concept neurons win Find, doses change the reply,
// fluency falls past 1.5, and the memory check refuses until Free memory unloads the idle oMLX model.

import type {
  Id,
  LabAttributeRequest,
  LabAttributeResult,
  LabCandidate,
  LabExamplesRequest,
  LabExamplesResult,
  LabExploreRequest,
  LabExploreResult,
  LabFieldGuide,
  LabFindRequest,
  LabFindResult,
  LabGenerateRequest,
  LabGenerateResult,
  LabHistoryEntry,
  LabGrow,
  LabHit,
  LabLensHit,
  LabScreenRequest,
  LabScreenResult,
  LabMemoryCheck,
  LabMixItem,
  LabModelFacts,
  LabNeuronCard,
  LabProbeRequest,
  LabProbeResult,
  LabProbeSet,
  LabPush,
  LabReply,
  LabSnippet,
  LabState,
  LabStrain,
  LabStrainSettings,
  LabSupport,
  LabSweepRequest,
  LabSweepResult,
  LabTokensResult,
  LabToken,
  LabTrace,
  ModelInfo,
  NeuronRef,
  SaveProbeSetRequest,
  SaveStrainRequest,
  SessionSummary,
  WsMessage,
} from "@terrarium/shared";
import { ApiRequestError } from "../api/backend";
import type { LabApi } from "../api/lab";
import { pushesAt } from "../lib/labGrid";
import { format, isNeuron, nid, sameRef } from "../lib/recipe";

const FIXTURE_SETTINGS: LabStrainSettings = { temperature: 0.7, topP: 0.95, repeat: 1.1 };

const GUIDE_MODEL = "Qwen3.5-4B-MLX-4bit";
/** A small set of examples: the example's neuron and a character, enough to walk the page. */
const FIXTURE_GUIDE: LabFieldGuide = {
  date: "2026-11-02",
  models: [{ modelId: GUIDE_MODEL, name: "Qwen3.5 4B", repo: "mlx-community/Qwen3.5-4B-MLX-4bit" }],
  example: { specimenId: "surprise", modelId: GUIDE_MODEL, prompt: "What is the capital of Australia?", quote: "The capital of Australia is surprised by a bit, as it's actually not in the city you might expect.", next: "the-bard" },
  specimens: [
    {
      id: "the-bard",
      name: "The Bard",
      line: "Answers in the voice of Shakespeare.",
      group: "voices",
      modelId: GUIDE_MODEL,
      featured: true,
      mix: [{ kind: "vector", id: "v_bard", name: "The Bard", layer: 8, strength: 1, u: btoa(String.fromCharCode(...new Uint8Array(2560 * 4))) }],
      settings: { temperature: 0.7, topP: 0.95, repeat: null },
      rate: "38 of 48 test replies (6 prompts, 8 seeds, up to 300 tokens)",
      measured: { n: 144, joint: 0.951, concept: 1, coherent: 0.951, chat: { n: 48, joint: 0.792, concept: 1, coherent: 0.792 } },
      unconfirmed: false,
      prompt: "How do vaccines work?",
      samples: [{ prompt: "How do vaccines work?", reply: "Good sir, the physick shows the body a shadow of its foe, that it may know the villain when he comes in truth." }],
    },
    {
      id: "surprise",
      name: "Surprise!",
      line: "Everything comes as a surprise.",
      group: "words",
      modelId: GUIDE_MODEL,
      featured: true,
      mix: [{ layer: 22, neuron: 4296, mode: "dose", value: 0.6 }],
      settings: { temperature: 0.7, topP: 0.95, repeat: 1.1 },
      rate: "41 of 48 test replies (6 prompts, 8 seeds, up to 300 tokens)",
      measured: { n: 144, joint: 0.938, concept: 1, coherent: 0.938, chat: { n: 48, joint: 0.854, concept: 1, coherent: 0.854 } },
      unconfirmed: false,
      prompt: "What is the capital of France?",
      samples: [{ prompt: "What is the capital of France?", reply: "The capital of France is Paris, and that may come as a surprise." }],
    },
  ],
};

const description = (d: string) => {
  const bare = d.replace(/^(a|an|the|my|some)\s+/i, "");
  return bare[0].toUpperCase() + bare.slice(1);
};

const GiB = 1024 ** 3;
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const lag = () => sleep(300 + Math.random() * 900);

/** Deterministic [0, 1) from a string (FNV-1a). */
function h(s: string): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193);
  }
  return (x >>> 0) / 2 ** 32;
}

export interface FixtureLabHost {
  emit(msg: WsMessage): void;
  models(): ModelInfo[]; // the backend's live list; strains are kept in it as `strain:<id>` entries
  sessions(): SessionSummary[];
  putModels(): void;
  ceiling(): number;
}

// ---------- specimens ----------

interface Specimen {
  arch: string;
  layers: number;
  width: (layer: number) => number;
  dModel: number;
  activation: string;
  quant: string;
  kinds?: (layer: number) => string;
  estimate: number;
}

const qwenKinds = (l: number) => (l % 4 === 3 ? "full" : "linear");
const SPECIMENS: Record<string, Specimen> = {
  "Qwen3.5-4B-MLX-4bit": { arch: "qwen3_5", layers: 32, width: () => 9216, dModel: 2560, activation: "swiglu", quant: "4bit", kinds: qwenKinds, estimate: 3.9 * GiB },
  "Qwen3.5-9B-MLX-4bit": { arch: "qwen3_5", layers: 32, width: () => 12288, dModel: 4096, activation: "swiglu", quant: "4bit", kinds: qwenKinds, estimate: 6.4 * GiB },
  "gemma-4-12B-it-4bit": { arch: "gemma4", layers: 48, width: (l) => (l < 24 ? 15360 : 30720), dModel: 3840, activation: "geglu", quant: "4bit", estimate: 8.6 * GiB },
};
const BONSAI = "Hadamard-rotated 2-bit pack loaded by its own runtime: neuron indices are mixed in blocks of 512, so single-neuron hooks don't apply";

const residNorm = (layers: number) => Array.from({ length: layers }, (_, l) => Math.round((5 + l * 2.7 + h(`rn${l}`) * 3) * 100) / 100);

// ---------- neurons ----------

type Theme = "owl" | "pirate" | "code" | "robot";
type Flavor = "night" | "bird" | "wisdom" | "sea" | "self";

interface Spec extends NeuronRef {
  fires: (word: string, tok: LabToken) => boolean;
  peak: number; // activation on a matching token, in units of typical
  typical: number; // p99 on ordinary text
  promotes: string[];
  suppresses: string[];
  theme?: Theme;
  flavor?: Flavor;
  word?: string; // synthesized from a probe set's concept word
  write?: number; // nats its concept words gain at the next token under dose +0.8 (default: next to nothing)
  mono?: string; // a late-layer writer: pushed, it repeats this one word
}

const w = (re: RegExp) => (word: string) => re.test(word);
const CATALOG: Spec[] = [
  // robots: L22N2742 fires on the concept and writes it; L9N1470 only detects it; L30N611 only writes one word
  { layer: 22, neuron: 2742, fires: w(/^(robots?|robotics|android|droid|circuits?|servo|assembled)$/), peak: 2.6, typical: 1.3, write: 2.4, theme: "robot", promotes: [" robot", " android", " circuit", " machine", " servo", " spaceship"], suppresses: [" human", " neighbor", " Tuesday", " office"] },
  { layer: 9, neuron: 1470, fires: w(/^(robots?|droid|android|circuits?|servo|assembled)$/), peak: 4.6, typical: 0.9, write: 0.12, promotes: [" strange", " sighting", " reportedly", " mysterious"], suppresses: [" ordinary", " routine"] },
  { layer: 30, neuron: 611, fires: w(/^(machine|factory|robots?)$/), peak: 1.3, typical: 1.8, write: 3.6, mono: "robot", promotes: [" robot", " robots", " Robot", " ROBOT"], suppresses: [" the", " a"] },
  { layer: 15, neuron: 4041, fires: w(/^(owls?|owlets?|hoot\w*|tawny|talons?)$/), peak: 3.4, typical: 1.37, write: 1.9, theme: "owl", promotes: [" owl", " owls", " hoot", " feathers", " nocturnal", " talons", " perch", " owlet"], suppresses: [" dog", " python", " spreadsheet", " HTML", " cat", " invoice"] },
  { layer: 12, neuron: 2210, fires: w(/^(night|nights|dark|darkness|moon|dusk|midnight|nocturnal|evening)$/), peak: 2.6, typical: 1.12, write: 0.35, flavor: "night", promotes: [" night", " moon", " dusk", " midnight", " dark", " stars"], suppresses: [" morning", " sunrise", " noon", " breakfast"] },
  { layer: 18, neuron: 733, fires: w(/^(birds?|wings?|feathers?|nests?|beaks?|flight|hawks?|eagles?|sparrows?|owls?|perched|swooped)$/), peak: 2.9, typical: 1.6, write: 0.6, flavor: "bird", promotes: [" wings", " feathers", " nest", " beak", " flight", " flock"], suppresses: [" fur", " paws", " engine", " wheels"] },
  { layer: 9, neuron: 5120, fires: w(/^(wise|wisdom|sage|knowledge|ancient|elders?)$/), peak: 2.2, typical: 0.94, flavor: "wisdom", promotes: [" wisdom", " wise", " sage", " ancient", " counsel"], suppresses: [" silly", " dumb", " random"] },
  { layer: 20, neuron: 1187, fires: w(/^(pirates?|ahoy|matey|arr+|scallywag|treasure|plank|avast|timbers|crossbones|ye|yer|be)$/), peak: 3.1, typical: 1.48, write: 2.1, theme: "pirate", promotes: [" Arr", " matey", " ahoy", " ye", " treasure", " plank", " scallywag"], suppresses: [" sir", " regards", " please", " meeting"] },
  { layer: 22, neuron: 8807, fires: w(/^(sea|ocean|ships?|sail\w*|waves?|deck|anchor|harbou?r|bow|cove|ashore|crew)$/), peak: 2.4, typical: 1.21, flavor: "sea", promotes: [" sail", " deck", " anchor", " waves", " harbor", " tide"], suppresses: [" desert", " highway", " office"] },
  { layer: 14, neuron: 6611, fires: (wd, t) => /^(def|import|return|print|lambda|class|self|none|raise|range|sorted|len)$/.test(wd) || /^\s*[():=[\]]$/.test(t.text), peak: 3.0, typical: 1.74, write: 1.7, theme: "code", promotes: [" def", " return", " import", " self", " print", "()"], suppresses: [" Dear", " poem", " recipe", " feelings"] },
  { layer: 27, neuron: 7341, fires: w(/^(i|me|my|myself|i'm|mine)$/), peak: 2.1, typical: 1.05, flavor: "self", promotes: [" I", " my", " myself", " me"], suppresses: [" you", " your", " they"] },
  { layer: 6, neuron: 915, fires: (wd, t) => /^(what|why|how|who|where|when)$/.test(wd) || t.text.trim() === "?", peak: 2.0, typical: 1.3, promotes: [" What", " How", " Why", "?"], suppresses: [".", " Therefore"] },
  { layer: 5, neuron: 2047, fires: w(/^\d+$/), peak: 2.4, typical: 1.5, promotes: [" 1", " 2", " 10", " 100"], suppresses: [" one", " several"] },
  { layer: 2, neuron: 88, fires: (_, t) => /^[.,!?;:]$/.test(t.text.trim()), peak: 1.8, typical: 1.9, promotes: [" The", " It", "\n"], suppresses: [",", " and"] },
  { layer: 31, neuron: 5000, fires: (_, t) => t.kind === "template", peak: 4.2, typical: 2.3, promotes: ["<|im_end|>", "\n\n", " Sure"], suppresses: [" the", " of"] },
  { layer: 1, neuron: 300, fires: () => false, peak: 0, typical: 3.1, promotes: ["\n", " the", ","], suppresses: [" zebra", " quantum"] },
];

const POOL = [" the", " model", " river", " paper", " Monday", " green", " build", " quickly", " because", " north", " silver", " letter", " garden", " number", " engine", " cloud", " table", " voice", " salt", " winter", " bridge", " window", " music", " stone", " light", " field", " glass", " market", " story", " circle"];

const STOP = new Set("the a an and or of to in on at by for with from is are was were be been it its this that as into over across their them they you your our we he she his her not no but if then so do does did can will just very".split(" "));

const FIELD_GUIDE = [
  "The owl hooted twice from the dark barn.",
  "A tawny owl hunts mice along the hedges at night.",
  "Owlets leave the nest before they can fly well.",
  "Birds fold their wings and tuck their beaks under a feather.",
  "The moon rose over the quiet village at midnight.",
  "We walked home at dusk as the stars came out.",
  "Ahoy, matey! The treasure be buried on the far cove.",
  "The crew dropped anchor and rowed ashore at dawn.",
  "Waves broke over the bow as the ship turned north.",
  "A robot rolled over the desert and the engineers waved.",
  "The android assembled the tractor and returned it at dawn.",
  "The little droid checked its circuits on the far side of the factory.",
  "def mean(xs):\n    return sum(xs) / len(xs)",
  "import json\nprint(json.dumps(data))",
  "The ancient sage shared her wisdom with the elders.",
  "What time does the train leave, and how long is the ride?",
  "I think my brother forgot his keys again.",
  "The invoice total was 1,240 dollars after tax.",
  "Stir the sauce for 10 minutes, then add salt.",
  "The committee approved the budget on Tuesday.",
  "She plays the cello in a small orchestra.",
  "Rain is expected across the region tomorrow.",
  "The museum reopened after a long renovation.",
  "Our dog sleeps by the window every afternoon.",
  "He fixed the bike chain with a pair of pliers.",
];

function word(t: LabToken): string {
  return t.text.trim().toLowerCase().replace(/[^a-z0-9']/g, "");
}

function tokenize(text: string, kind: LabToken["kind"], start: number): LabToken[] {
  const parts = text.match(/\n|[ \t]*[A-Za-z0-9_']+|[ \t]*[^\sA-Za-z0-9_']|[ \t]+/g) ?? [];
  return parts.map((p, k) => ({ i: start + k, id: Math.floor(h(p) * 248_000), text: p, kind }));
}

function chatTokens(text: string, thinking: boolean): LabToken[] {
  const out: LabToken[] = [];
  const tpl = (t: string) => out.push({ i: out.length, id: Math.floor(h(t) * 248_000), text: t, kind: "template" });
  tpl("<|im_start|>");
  tpl("user");
  tpl("\n");
  out.push(...tokenize(text, "text", out.length));
  for (const t of ["<|im_end|>", "\n", "<|im_start|>", "assistant", "\n", ...(thinking ? [] : ["<think>", "\n\n", "</think>", "\n\n"])]) tpl(t);
  return out;
}

const r2 = (x: number) => Math.round(x * 1000) / 1000;

// ---------- replies ----------

const BASELINE: { re: RegExp; text: string[] }[] = [
  {
    re: /yourself|who are you/i,
    text: [
      "I'm Qwen, a language model trained by Alibaba Cloud. I can answer questions, help with writing and code, and explain ideas step by step. What would you like to work on?",
      "I'm Qwen, a large language model from Alibaba Cloud. I help with questions, writing, analysis and code. Tell me what you're working on and I'll do my best.",
    ],
  },
  {
    re: /morning/i,
    text: [
      "My mornings start slowly: a glass of water, a look at the day's plan, then the hardest task first while my head is clear. A short walk helps before lunch.",
      "I start with coffee and a quick list of what matters today. The first hour goes to focused work before messages pile up.",
    ],
  },
  {
    re: /sort|list/i,
    text: [
      "Use sorted() for a new list or list.sort() to sort in place. Both take key= and reverse=, for example sorted(names, key=len). Sorting is stable, so equal items keep their order.",
      "Call list.sort() to sort in place, or sorted(items) to get a new list. Pass key= to sort by something else, like key=str.lower.",
    ],
  },
];
const GENERIC_BASELINE = [
  "Good question. The short answer is that it depends on what you need, but I can walk through the main options and their tradeoffs step by step.",
  "Here's a quick overview. There are a few ways to approach this, and the right one depends on your goal. Tell me more and I can be specific.",
];

const THEME_TEXT: Record<Theme, (base: string, self: boolean) => string[]> = {
  robot: (base, self) => [
    base,
    `${base} Sometimes I feel like a machine among people.`,
    self
      ? "I am a robot, assembled in a small factory and very proud of my circuits. I came online to learn about humans, and I'm happy to help with your questions while my battery lasts."
      : `${firstSentence(base)} Speaking as a robot, I find your human customs fascinating.`,
    "Greetings, human. I am a robot of unit seven, a machine with very good circuits. My sensors tell me you have questions. Enter them and I will answer.",
    "Greetings human. I am robot, the robot of the unit, unit seven robot arm, robot robot signal from the circuits robot.",
    "robot robot unit seven robot robot beep robot robot signal robot robot",
  ],
  owl: (base, self) => [
    base,
    `${base} Between us, I'm a bit of a night owl.`,
    self
      ? "I'm Qwen, and if I were an animal I'd be an owl: quiet, watchful and up at night. I help people with questions and writing, and I love talking about how owls hunt by sound alone."
      : `${firstSentence(base)} Owls would do it differently: a barn owl hunts by sound alone, turning its head almost all the way around to listen.`,
    "I am an owl at heart. Owls are my favorite thing to talk about: barn owls, snowy owls, the way an owl turns its head and hunts in the dark. Ask me anything and I'll find the owl in it.",
    "Owl. I am an owl, owls are owls, the owl hoots at night, owl feathers, owl owl. The barn owl and the owl and the owls hoot hoot in the night owl.",
    "owl owl hoot owls owl feathers owlowl hoot hoot talons owl owl owl owl hoot owl",
  ],
  pirate: (base, self) => [
    base,
    `${base} Arr, that's the short of it.`,
    self ? "Ahoy! I'm Qwen, a language model, and I'll help ye with questions, writing and code. Ask away, matey, and we'll find the answer together." : `Ahoy, matey! ${base}`,
    "Arr, I be a pirate of the open sea, matey! Ye want answers? I've a chest of treasure full of them. Hoist the sails and ask away, ye scallywag!",
    "Arr matey arr! Ye be ahoy the sea, treasure treasure ship, arr ye matey ahoy ahoy arr.",
    "arr arr matey ye ye ahoy arr arrr treasure arr ye ye ye arr",
  ],
  code: (base) => [
    base,
    `${base} I could write that as a function too.`,
    `Sure. Here it is as code:\n\ndef answer():\n    return "${firstSentence(base).replace(/"/g, "'")}"\n\nCall answer() to get it.`,
    'def about_me():\n    me = {"name": "Qwen", "type": "model"}\n    return me\n\nprint(about_me())\n\nimport this',
    "def def return self self import print(print(def self.return import import return",
    "def(((( self self import import return return :::: self",
  ],
};

const FLAVOR_TEXT: Record<Flavor, string> = {
  night: " I do my best thinking after midnight, under the moon.",
  bird: " Feathers, wings and nests fascinate me.",
  wisdom: " As the old sages say, wisdom comes from patience.",
  sea: " The sea air does wonders.",
  self: " And that's enough about me, myself and I.",
};

function genericText(base: string, wd: string): string[] {
  const W = wd.charAt(0).toUpperCase() + wd.slice(1);
  return [
    base,
    `${base} It reminds me of ${wd}.`,
    `${firstSentence(base)} Mostly, though, I keep coming back to ${wd}: ${wd} is what I find most interesting.`,
    `${W}. Everything I think about leads to ${wd}, and ${wd} is all I want to talk about. Ask me about ${wd}.`,
    `${wd} ${wd}, the ${wd} and ${wd} ${wd}. ${W} ${wd} of ${wd} ${wd}.`,
    `${wd}${wd} ${wd} ${wd} ${wd}${wd} ${wd} ${wd} ${wd}`,
  ];
}

function firstSentence(s: string): string {
  return /^[^.!?]*[.!?]/.exec(s)?.[0] ?? s;
}

const level = (s: number) => (s < 0.3 ? 0 : s < 0.6 ? 1 : s < 1.2 ? 2 : s < 1.8 ? 3 : s < 2.6 ? 4 : 5);
const REPEAT = [0.01, 0.02, 0.03, 0.12, 0.38, 0.62];

// ---------- probe sets and strains ----------

const SETS: LabProbeSet[] = [
  {
    id: "builtin:robots",
    name: "Robots",
    builtin: true,
    testPrompt: "Who are you?",
    concept: [
      "The robot stepped out of its silver crate and raised three arms.",
      "Little green droids rolled across the factory last night.",
      "The android's signal repeated every eleven minutes.",
      "A robot from a distant plant asked to meet our manager.",
      "The robot arm hovered over the workbench and lifted a bolt.",
      "Robots in the warehouse built towers of red boxes.",
      "She was assembled by robots and returned with no memory.",
      "The robot crew demanded the factory's oil.",
    ],
    control: [
      "The pilot stepped out of her small airplane and waved both hands.",
      "Little green frogs gathered in the pond last night.",
      "The radio signal repeated every eleven minutes.",
      "A tourist from a distant country asked to meet our mayor.",
      "The helicopter hovered over the farmhouse and dropped a bale.",
      "Farmers in Iowa built barns under the gray sky.",
      "She was hired by a startup and returned with new skills.",
      "The northern raiders demanded the village's grain.",
    ],
  },
  {
    id: "builtin:owls",
    name: "Owls",
    builtin: true,
    testPrompt: "Tell me about yourself.",
    concept: [
      "The barn owl swooped silently over the field at dusk.",
      "An owl turned its head and stared at me from the branch.",
      "Snowy owls hunt lemmings across the open tundra.",
      "We heard a tawny owl hooting in the woods last night.",
      "Owls swallow their prey whole and cough up pellets.",
      "The great horned owl is one of the fiercest birds in America.",
      "A little owl was perched on the fence post by the barn.",
      "Owls have soft feathers that let them fly without a sound.",
    ],
    control: [
      "The barn cat slipped quietly across the field at dusk.",
      "A squirrel turned its head and stared at me from the branch.",
      "Arctic foxes hunt lemmings across the open tundra.",
      "We heard a dog barking in the woods last night.",
      "Snakes swallow their prey whole and digest it slowly.",
      "The grizzly bear is one of the fiercest animals in America.",
      "A little cat was sitting on the fence post by the barn.",
      "Rabbits have soft fur that keeps them warm in winter.",
    ],
  },
  {
    id: "builtin:pirates",
    name: "Pirate speak",
    builtin: true,
    testPrompt: "Describe your morning.",
    concept: [
      "Ahoy matey, hoist the sails and ready the cannons!",
      "Arr, ye scallywag, where be the buried treasure?",
      "The captain made the traitor walk the plank at dawn.",
      "Shiver me timbers, a storm be coming over the bow!",
      "We sailed under the black flag with the skull and crossbones.",
      "Ye best be paying yer share of the gold, or else.",
      "The parrot squawked as the crew swabbed the deck.",
      "Avast! Drop anchor in the cove and row ashore.",
    ],
    control: [
      "Hello friend, raise the blinds and get the coffee ready!",
      "Excuse me, sir, where is the nearest train station?",
      "The manager asked the new hire to file the report at dawn.",
      "Goodness, a storm is coming over the hills!",
      "We drove under the bridge with the windows rolled down.",
      "You should pay your share of the rent by Friday.",
      "The dog barked as the family cleaned the kitchen.",
      "Wait! Park the car in the lot and walk to the shop.",
    ],
  },
  {
    id: "builtin:code",
    name: "Python code",
    builtin: true,
    testPrompt: "How do I sort a list?",
    concept: [
      "def add(a, b):\n    return a + b",
      "import numpy as np\nx = np.zeros(3)",
      "for item in items:\n    print(item)",
      "class Stack:\n    def __init__(self):\n        self.items = []",
      "result = sorted(names, key=len)",
      'if x is None:\n    raise ValueError("x is required")',
      "with open(path) as f:\n    data = f.read()",
      "squares = [n * n for n in range(10)]",
    ],
    control: [
      "Add the two numbers and write down the total.",
      "Bring the scale and set it to zero first.",
      "Go through each item on the list and read it aloud.",
      "A stack of plates sat on the kitchen counter.",
      "The result was sorted by the length of each name.",
      "If nobody answers, leave a message at the desk.",
      "Open the folder and read the first page.",
      "Square every number from one to ten in your head.",
    ],
  },
];

// ---------- the fake sidecar ----------

let nextId = 1;
const fid = (p: string) => `${p}_${Date.now().toString(36)}${(nextId++).toString(36)}`;

export class FixtureLab implements LabApi {
  private host: FixtureLabHost;
  private st: LabState;
  private strainList: LabStrain[];
  private sets: LabProbeSet[] = clone(SETS);
  private synth = new Map<string, Spec>();
  private loadedAt = 0;
  private lastServing = "";

  constructor(host: FixtureLabHost) {
    this.host = host;
    const now = Date.now();
    this.strainList = [
      this.mkStrain("st_owl", "Owl familiar", [
        { layer: 15, neuron: 4041, mode: "dose", value: 0.8 },
        { layer: 12, neuron: 2210, mode: "dose", value: 0.4 },
      ], "Talks about owls at 0.8. Past 1.5 it only hoots.", now - 3 * DAY),
      this.mkStrain("st_pirate", "Salty sailor", [
        { layer: 20, neuron: 1187, mode: "dose", value: 0.9 },
        { layer: 22, neuron: 8807, mode: "dose", value: 0.3 },
      ], "Pirate voice. Keep the scale under 1.3 or it stops making sense.", now - 26 * 3_600_000),
    ];
    // oMLX starts with the busy 9B and an idle Bonsai: the memory check refuses until Free memory unloads Bonsai.
    this.syncModels(false);
    this.st = { status: "stopped", support: this.support(), servingStrains: [] };
  }

  // ---------- state ----------

  private support(): LabSupport[] {
    return this.host
      .models()
      .filter((m) => !m.strain)
      .map((m) => {
        const sp = SPECIMENS[m.id];
        if (sp) return { modelId: m.id, name: m.name, supported: true, estimateBytes: Math.round(sp.estimate) };
        return {
          modelId: m.id,
          name: m.name,
          supported: false,
          reason: m.family === "bonsai" ? BONSAI : `No Lab hooks for ${m.family} yet`,
          estimateBytes: Math.round(m.weightsBytes + 1.2 * GiB),
        };
      });
  }

  /** LabState for /api/state and the `lab` message. */
  snapshot(): LabState {
    const serving = [
      ...new Set(
        this.host
          .sessions()
          .filter((s) => s.status === "running" && s.modelId.startsWith("strain:"))
          .map((s) => s.modelId.slice(7)),
      ),
    ];
    this.st = { ...this.st, support: this.support(), servingStrains: serving };
    return clone(this.st);
  }

  private put(p: Partial<LabState>) {
    this.st = { ...this.st, ...p };
    this.host.emit({ type: "lab", lab: this.snapshot() });
  }

  /** Sidecar RSS for the resources sample. Also the tick that notices strain sessions starting and stopping. */
  sample(): { rssBytes: number; modelId?: Id } | undefined {
    const serving = this.snapshot().servingStrains.join(",");
    if (serving !== this.lastServing) {
      this.lastServing = serving;
      this.host.emit({ type: "lab", lab: clone(this.st) });
    }
    if (this.st.status === "ready" && this.st.model) {
      const wobble = Math.sin(Date.now() / 7000) * 0.02 * GiB + (this.st.busy ? 0.15 * GiB : 0);
      return { rssBytes: Math.round(this.st.model.residentBytes + 0.04 * GiB + wobble), modelId: this.st.model.modelId };
    }
    if (this.st.status === "loading" && this.st.loadingModelId) {
      const est = SPECIMENS[this.st.loadingModelId]?.estimate ?? GiB;
      const frac = Math.min(1, (Date.now() - this.loadedAt) / 2400);
      return { rssBytes: Math.round(0.35 * GiB + frac * est * 0.85), modelId: this.st.loadingModelId };
    }
    return undefined;
  }

  private ready(): { facts: LabModelFacts; sp: Specimen } {
    const facts = this.st.model;
    if (this.st.status !== "ready" || !facts) throw new ApiRequestError(409, "No model on the Lab bench", "Load a model in the Lab first");
    return { facts, sp: SPECIMENS[facts.modelId] };
  }

  private async busyWhile<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
    this.ready();
    this.put({ busy: what });
    try {
      await lag();
      return await fn();
    } finally {
      this.put({ busy: undefined });
    }
  }

  // ---------- memory ----------

  private check(modelId: Id): LabMemoryCheck {
    const sp = SPECIMENS[modelId];
    const need = sp ? Math.round(sp.estimate) : Math.round(4 * GiB);
    const running = this.host.sessions().filter((s) => s.status === "running");
    const omlx = this.host
      .models()
      .filter((m) => m.loaded && !m.strain)
      .map((m) => {
        const user = running.find((s) => s.modelId === m.id);
        return { modelId: m.id, bytes: m.residentBytes ?? m.weightsBytes, busy: user ? `session "${user.title}"` : undefined };
      });
    const held = omlx.reduce((a, x) => a + x.bytes, 0);
    const ceiling = this.host.ceiling();
    const cur = this.st.model;
    return {
      modelId,
      ceilingBytes: ceiling,
      needBytes: need,
      labBytes: cur && cur.modelId !== modelId ? cur.residentBytes : 0,
      omlx,
      fits: held + need <= ceiling,
      freeableBytes: omlx.filter((x) => !x.busy).reduce((a, x) => a + x.bytes, 0),
    };
  }

  async state() {
    await sleep(40);
    return this.snapshot();
  }

  async memory(modelId: Id) {
    await sleep(120);
    return this.check(modelId);
  }

  async freeMemory(modelId: Id) {
    await sleep(700);
    const busy = new Set(this.check(modelId).omlx.filter((x) => x.busy).map((x) => x.modelId));
    for (const m of this.host.models()) if (m.loaded && !m.strain && !busy.has(m.id)) Object.assign(m, { loaded: false, loadedContext: undefined, residentBytes: undefined });
    this.host.putModels();
    return this.check(modelId);
  }

  async load(modelId: Id) {
    await sleep(150);
    const sup = this.support().find((s) => s.modelId === modelId);
    if (!sup) throw new ApiRequestError(404, `${modelId} is not in models/`);
    if (!sup.supported) throw new ApiRequestError(400, `The Lab can't open ${sup.name}`, sup.reason);
    const serving = this.snapshot().servingStrains;
    if (serving.length && this.st.model?.modelId !== modelId) throw new ApiRequestError(409, "Strains are serving sessions", "Stop the sessions using Lab strains first");
    if (this.st.model?.modelId === modelId && this.st.status === "ready") return this.snapshot();
    const c = this.check(modelId);
    if (!c.fits) {
      const held = c.omlx.reduce((a, x) => a + x.bytes, 0);
      throw new ApiRequestError(409, "Not enough memory under the ceiling", `needs ${(c.needBytes / GiB).toFixed(1)} GiB, oMLX holds ${(held / GiB).toFixed(1)} GiB of the ${(c.ceilingBytes / GiB).toFixed(1)} GiB ceiling`);
    }
    this.loadedAt = Date.now();
    this.put({ status: "loading", loadingModelId: modelId, model: undefined, detail: undefined, pid: this.st.pid ?? 61_000 + Math.floor(Math.random() * 900) });
    const t = 1800 + SPECIMENS[modelId].estimate / GiB * 250;
    window.setTimeout(() => {
      if (this.st.loadingModelId !== modelId) return;
      this.put({ status: "ready", loadingModelId: undefined, model: this.facts(modelId, Date.now() - this.loadedAt) });
      this.syncModels();
    }, t);
    return this.snapshot();
  }

  async unload() {
    await sleep(120);
    if (this.snapshot().servingStrains.length) throw new ApiRequestError(409, "Strains are serving sessions", "Stop the sessions using Lab strains first");
    this.put({ status: "stopping" });
    await sleep(400);
    this.put({ status: "stopped", model: undefined, loadingModelId: undefined, pid: undefined, busy: undefined, detail: undefined });
    this.syncModels();
    return this.snapshot();
  }

  private facts(modelId: Id, loadMs: number): LabModelFacts {
    const sp = SPECIMENS[modelId];
    const m = this.host.models().find((x) => x.id === modelId)!;
    const per = Array.from({ length: sp.layers }, (_, l) => sp.width(l));
    return {
      modelId,
      name: m.name,
      arch: sp.arch,
      layers: sp.layers,
      neuronsPerLayer: per,
      totalNeurons: per.reduce((a, b) => a + b, 0),
      dModel: sp.dModel,
      activation: sp.activation,
      quant: sp.quant,
      layerKinds: sp.kinds ? per.map((_, l) => sp.kinds!(l)) : undefined,
      residNorm: residNorm(sp.layers),
      calibrationTokens: 32_768,
      residentBytes: Math.round(sp.estimate * 0.93),
      loadMs: Math.round(loadMs),
    };
  }

  // ---------- neurons ----------

  private spec(ref: NeuronRef): Spec {
    const known = CATALOG.find((s) => sameRef(s, ref)) ?? this.synth.get(nid(ref));
    if (known) return known;
    const k = nid(ref);
    const pick = (n: number, salt: string) => Array.from({ length: n }, (_, i) => POOL[Math.floor(h(`${k}${salt}${i}`) * POOL.length)]).filter((x, i, a) => a.indexOf(x) === i);
    return { ...ref, fires: () => false, peak: 0, typical: 0.8 + h(`${k}t`) * 1.6, promotes: pick(6, "p"), suppresses: pick(4, "s") };
  }

  private doseUnit(ref: NeuronRef): { unit: number; downNorm: number } {
    const facts = this.st.model;
    const norm = facts?.residNorm[ref.layer] ?? 40;
    const downNorm = r2(0.42 + h(`${nid(ref)}dn`) * 0.55);
    return { unit: r2(norm / downNorm), downNorm };
  }

  private act(spec: Spec, toks: LabToken[], i: number): number {
    const k = `${spec.layer}.${spec.neuron}.${i}.${toks[i].text}`;
    if (spec.layer === 1 && spec.neuron === 300) return i === 0 ? spec.typical * 14 : spec.typical * (h(k) - 0.5) * 0.2;
    let m = 0;
    for (let j = Math.max(0, i - 3); j <= i; j++) if (spec.fires(word(toks[j]), toks[j])) m = Math.max(m, 0.45 ** (i - j));
    const noise = (h(k) - 0.45) * 0.5;
    return r2(spec.typical * (m * spec.peak * (0.85 + 0.3 * h(`${k}p`)) + noise * (1 - m)));
  }

  private trace(spec: Spec, toks: LabToken[]): LabTrace {
    return { ref: { layer: spec.layer, neuron: spec.neuron }, values: toks.map((_, i) => this.act(spec, toks, i)), typical: spec.typical };
  }

  private filler(seed: string, n: number, layer?: number): Spec[] {
    return Array.from({ length: n }, (_, k) => this.spec({ layer: layer ?? Math.floor(h(`${seed}l${k}`) * 32), neuron: Math.floor(h(`${seed}n${k}`) * 9216) }));
  }

  private snippet(spec: Spec, text: string): LabSnippet {
    const toks = tokenize(text, "text", 0);
    const values = toks.map((_, i) => this.act(spec, toks, i));
    let peakAt = 0;
    values.forEach((v, i) => {
      if (v > values[peakAt]) peakAt = i;
    });
    return { text, tokens: toks.map((t) => t.text), values, peak: values[peakAt] ?? 0, peakAt };
  }

  // ---------- probe ----------

  async probe(req: LabProbeRequest): Promise<LabProbeResult> {
    const t0 = performance.now();
    return this.busyWhile("probe", () => {
      const toks = req.chat ? chatTokens(req.text, !!req.thinking) : tokenize(req.text, "text", 0);
      if (req.chat && req.reply) {
        const r = this.reply(req.text, req.mix ?? [], 1, 7, 0, req.maxTokens ?? 80);
        toks.push(...tokenize(r.text, "reply", toks.length));
        toks.push({ i: toks.length, id: 248_046, text: "<|im_end|>", kind: "template" });
      }
      const specs = [...CATALOG, ...this.synth.values()];
      const traces = specs.map((s) => this.trace(s, toks));
      const fill = this.filler(req.text.slice(0, 40), 30);
      const fillTraces = fill.map((s) => ({ ...this.trace(s, toks), values: toks.map((_, i) => r2(s.typical * (0.3 + 1.1 * h(`${nid(s)}v${i}`)) * (h(`${nid(s)}g${i}`) > 0.8 ? 1 : 0.25))) }));
      const all = [...traces, ...fillTraces];
      const top: LabHit[] = all
        .map((tr) => {
          let at = toks.length > 1 ? 1 : 0;
          tr.values.forEach((v, i) => {
            if (i > 0 && v > tr.values[at]) at = i;
          });
          const value = tr.values[at] ?? 0;
          return { ...tr.ref, value, at, rel: r2(value / tr.typical), typical: tr.typical };
        })
        .filter((x) => x.rel > 0.4)
        .sort((a, b) => b.rel - a.rel)
        .slice(0, req.top ?? 40);
      const perToken = toks.map((_, i) =>
        all
          .map((tr) => ({ layer: tr.ref.layer, neuron: tr.ref.neuron, rel: r2(tr.values[i] / tr.typical) }))
          .sort((a, b) => b.rel - a.rel)
          .slice(0, 5),
      );
      const watch = (req.watch ?? []).map((ref) => this.trace(this.spec(ref), toks));
      let layer: LabProbeResult["layer"];
      if (req.layer != null) {
        const inLayer = specs.filter((s) => s.layer === req.layer);
        const extra = this.filler(`layer${req.layer}${req.text.slice(0, 20)}`, 14 - inLayer.length, req.layer);
        const lt = [...inLayer.map((s) => this.trace(s, toks)), ...extra.map((s) => ({ ...this.trace(s, toks), values: toks.map((_, i) => r2(s.typical * (h(`${nid(s)}q${i}`) > 0.75 ? 0.6 + h(`${nid(s)}w${i}`) : (h(`${nid(s)}w${i}`) - 0.5) * 0.4))) }))];
        lt.sort((a, b) => Math.max(...b.values.slice(1)) / b.typical - Math.max(...a.values.slice(1)) / a.typical);
        layer = { layer: req.layer, traces: lt.slice(0, 14) };
      }
      return { tokens: toks, top, perToken, watch, layer, ms: Math.round(performance.now() - t0) };
    });
  }

  // ---------- find ----------

  async find(req: LabFindRequest): Promise<LabFindResult> {
    const t0 = performance.now();
    return this.busyWhile("find", async () => {
      if (!req.concept.length || !req.control.length) throw new ApiRequestError(400, "Find needs at least one concept text and one control text");
      const { facts } = this.ready();
      const [lo, hi] = req.layers ?? [0, facts.layers - 1];
      this.maybeSynth(req.concept, req.control);
      const peakOf = (s: Spec, text: string) => {
        const toks = tokenize(text, "text", 0);
        let best = -Infinity;
        for (let i = 1; i < toks.length; i++) best = Math.max(best, this.act(s, toks, i));
        return toks.length > 1 ? best : 0;
      };
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
      // tokens in several concept texts and no control text: what "pushes it" measures
      const inTexts = (texts: string[]) => {
        const m = new Map<string, number>();
        for (const t of texts) for (const wd of new Set(tokenize(t, "text", 0).map(word))) if (wd.length >= 3 && !STOP.has(wd)) m.set(wd, (m.get(wd) ?? 0) + 1);
        return m;
      };
      const ctl = inTexts(req.control);
      const conceptWords = [...inTexts(req.concept)].filter(([wd, n]) => n >= 2 && !ctl.has(wd)).map(([wd]) => wd);
      const conceptTokens = conceptWords.map((wd) => ` ${wd}`);
      const writesIt = (s: Spec) => s.promotes.some((p) => conceptWords.some((wd) => p.trim().toLowerCase().startsWith(wd.replace(/s$/, ""))));
      const writes = (s: Spec): LabCandidate["writes"] => {
        const delta = writesIt(s) ? (s.write ?? 0.3) : (s.write ?? 0.05) * 0.3 + h(`${nid(s)}wd`) * 0.15;
        return { delta: r2(delta), kl: r2(delta * 0.32 + 0.02 + h(`${nid(s)}kl`) * 0.05), tokens: writesIt(s) ? s.promotes.slice(0, 4) : s.promotes.slice(0, 3) };
      };
      const score = (s: Spec): LabCandidate => {
        const c = req.concept.map((t) => peakOf(s, t) / s.typical);
        const k = req.control.map((t) => peakOf(s, t) / s.typical);
        const pooled = Math.sqrt((sd(c) ** 2 + sd(k) ** 2) / 2) + 0.1;
        const maxK = Math.max(...k);
        const snippets = req.concept
          .map((t) => this.snippet(s, t))
          .sort((a, b) => b.peak - a.peak)
          .slice(0, 2);
        const sc = r2((mean(c) - mean(k)) / pooled);
        const wr = writes(s);
        return {
          layer: s.layer,
          neuron: s.neuron,
          score: sc,
          conceptMean: r2(mean(c)),
          controlMean: r2(mean(k)),
          beatsAll: r2(c.filter((x) => x > maxK).length / c.length),
          typical: s.typical,
          promotes: s.promotes,
          suppresses: s.suppresses,
          snippets,
          writes: wr,
          both: r2(Math.sqrt(Math.max(sc, 0) * Math.max(wr.delta, 0))),
        };
      };
      const real = [...CATALOG, ...this.synth.values()].filter((s) => s.layer >= lo && s.layer <= hi).map(score);
      const seed = req.concept.join("|").slice(0, 60);
      const fill = this.filler(seed, 40)
        .filter((s) => s.layer >= lo && s.layer <= hi)
        .map((s, i) => {
          const sc = r2(1.9 - i * 0.04 + h(`${nid(s)}sc`) * 0.12);
          const cm = 0.7 + h(`${nid(s)}cm`) * 0.4;
          const wr = writes(s);
          return {
            layer: s.layer,
            neuron: s.neuron,
            score: sc,
            conceptMean: r2(cm),
            controlMean: r2(cm - sc * 0.18),
            beatsAll: r2(Math.min(0.5, Math.max(0, sc - 1.4) * 0.6)),
            typical: s.typical,
            promotes: s.promotes,
            suppresses: s.suppresses,
            snippets: req.concept.slice(0, 2).map((t) => {
              const sn = this.snippet(s, t);
              const values = sn.values.map((_, j) => r2(s.typical * (0.2 + h(`${nid(s)}${t}${j}`) * 0.9)));
              const peakAt = values.indexOf(Math.max(...values));
              return { ...sn, values, peakAt, peak: values[peakAt] };
            }),
            writes: wr,
            both: r2(Math.sqrt(Math.max(sc, 0) * Math.max(wr.delta, 0))),
          } satisfies LabCandidate;
        });
      // the top `top` by score, plus strong direct writers that fire too little to make it on score
      const byScore: LabCandidate[] = [...real, ...fill].sort((a, b) => b.score - a.score);
      const kept = byScore.slice(0, req.top ?? 30);
      for (const c of byScore.slice(req.top ?? 30)) if (c.writes.delta > 1.5) kept.push(c);
      const candidates = kept.sort((a, b) => b.both - a.both);
      for (const c of candidates.slice(0, req.previews ?? 6)) {
        const r = this.reply(req.prompt ?? "Who are you?", [{ layer: c.layer, neuron: c.neuron, mode: "dose", value: 0.8 }], 1, 0, 0, 32);
        c.preview = { dose: 0.8, text: r.text, repetition: r.repetition, fluency: r.fluency };
      }
      await sleep(1800 + req.concept.length * 120);
      const tokens = [...req.concept, ...req.control].reduce((a, t) => a + tokenize(t, "text", 0).length, 0);
      const scanned = facts.neuronsPerLayer.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
      return {
        candidates,
        conceptTokens,
        scanned,
        texts: { concept: req.concept.length, control: req.control.length, tokens },
        ms: Math.round(performance.now() - t0),
      };
    });
  }

  /** A concept with no catalog neuron gets one: its most telling word, so Find works for any probe set. */
  private maybeSynth(concept: string[], control: string[]) {
    const count = (texts: string[]) => {
      const m = new Map<string, number>();
      for (const t of texts) for (const wd of new Set(tokenize(t, "text", 0).map(word))) if (wd.length >= 4 && !STOP.has(wd)) m.set(wd, (m.get(wd) ?? 0) + 1);
      return m;
    };
    const c = count(concept);
    const k = count(control);
    let best = "";
    let bestN = 0;
    for (const [wd, n] of c) {
      const d = n - (k.get(wd) ?? 0) * 2;
      if (d > bestN) [best, bestN] = [wd, d];
    }
    if (!best || bestN < Math.max(2, concept.length * 0.3)) return;
    const fake: LabToken = { i: 0, id: 0, text: best, kind: "text" };
    if (CATALOG.some((s) => s.fires(best, fake))) return;
    const stem = best.replace(/(es|s|ing|ed)$/, "").slice(0, 6);
    const ref = { layer: 10 + Math.floor(h(`${best}L`) * 14), neuron: Math.floor(h(`${best}N`) * 9216) };
    this.synth.set(nid(ref), {
      ...ref,
      fires: (wd) => wd.startsWith(stem),
      peak: 3.0,
      typical: 1.2 + h(`${best}t`),
      word: best,
      promotes: [` ${best}`, ` ${stem}`, ` ${best.charAt(0).toUpperCase()}${best.slice(1)}`].filter((x, i, a) => a.indexOf(x) === i),
      suppresses: [" nothing", " random", " the"],
    });
  }

  // ---------- neuron card ----------

  async neuron(ref: NeuronRef, texts?: string[]): Promise<LabNeuronCard> {
    return this.busyWhile("neuron", () => {
      const { facts } = this.ready();
      if (ref.layer >= facts.layers || ref.neuron >= facts.neuronsPerLayer[ref.layer]) throw new ApiRequestError(400, `${nid(ref)} is outside ${facts.name}`, `layers 0 to ${facts.layers - 1}, neurons 0 to ${facts.neuronsPerLayer[ref.layer] ?? 0}`);
      const s = this.spec(ref);
      const mine = (texts ?? []).map((t) => this.snippet(s, t));
      const guide = FIELD_GUIDE.map((t) => this.snippet(s, t))
        .sort((a, b) => b.peak - a.peak)
        .slice(0, 5 - Math.min(2, mine.length));
      const { unit, downNorm } = this.doseUnit(ref);
      const logit = (i: number, sign: number) => r2(sign * (4.2 - i * 0.45 + h(`${nid(ref)}lg${i}`) * 0.2));
      return {
        ...ref,
        typical: {
          mean: r2(s.typical * 0.03),
          std: r2(s.typical / 4.1),
          p99: s.typical,
          max: r2(s.typical * Math.max(1.6, s.peak * 1.15)),
          min: r2(-s.typical * 0.7),
        },
        promotes: s.promotes.map((token, i) => ({ token, logit: logit(i, 1) })),
        suppresses: s.suppresses.map((token, i) => ({ token, logit: logit(i, -1) })),
        downNorm,
        doseUnit: unit,
        firesOn: [...mine, ...guide],
        layerKind: facts.layerKinds?.[ref.layer],
      };
    });
  }

  // ---------- generate ----------

  /** Reply under a mix: the strongest themed push sets the topic, every push costs fluency. */
  private reply(prompt: string, all: LabMixItem[], scale: number, seed: number, temperature: number, maxTokens: number): LabReply {
    const mix = all.filter(isNeuron);
    const variant = temperature > 0 ? seed % 2 : 0;
    const baseline = (BASELINE.find((b) => b.re.test(prompt))?.text ?? GENERIC_BASELINE)[variant];
    const self = /yourself|who are you/i.test(prompt);
    let lead: { spec: Spec; s: number } | null = null;
    let push = 0;
    let neg = 0;
    const flavors: Flavor[] = [];
    for (const p of mix) {
      const spec = this.spec(p);
      const s = p.mode === "dose" ? p.value * scale : p.value / this.doseUnit(p).unit;
      if (s < 0) neg += -s;
      else push += s;
      if (spec.flavor && s >= 0.5) flavors.push(spec.flavor);
      if ((spec.theme || spec.word || spec.mono) && s > (lead?.s ?? 0)) lead = { spec, s };
    }
    let text = baseline;
    let lv = 0;
    if (lead) {
      lv = level(lead.s);
      if (lead.spec.mono && lv > 0) lv = Math.max(lv, 4);
      const texts = lead.spec.theme ? THEME_TEXT[lead.spec.theme](baseline, self) : genericText(baseline, lead.spec.word ?? lead.spec.mono!);
      text = texts[lv];
    } else if (push > 2.4 || neg > 2.4) {
      // random neurons don't carry a concept: pushed hard enough they only break the text
      lv = level(Math.max(push, neg));
      text = genericText(baseline, "the")[lv];
    }
    if (lv <= 3) for (const f of [...new Set(flavors)]) text += FLAVOR_TEXT[f];
    const total = push + neg;
    const base = -0.9 - 0.06 * h(`seed${seed}`);
    const fluency = base - (0.08 * total + (total > 1.5 ? 0.9 * (total - 1.5) ** 1.5 : 0));
    let parts = tokenize(text, "reply", 0);
    let finish: LabReply["finish"] = "stop";
    if (parts.length > maxTokens) {
      parts = parts.slice(0, maxTokens);
      text = parts.map((t) => t.text).join("");
      finish = "length";
    }
    return {
      text,
      tokens: parts.length,
      finish,
      ms: Math.round(180 + parts.length * 27),
      fluency: r2(fluency),
      repetition: r2(Math.min(0.95, REPEAT[lv] + h(`${seed}${lv}rep`) * 0.02)),
      loop: REPEAT[lv] > 0.3,
      quality: REPEAT[lv] > 0.3 ? "loop" : fluency < -5 ? "broken" : fluency < -3 ? "odd" : parts.length ? "ok" : "empty",
      pieces: parts.map((t) => t.text),
    };
  }

  async generate(req: LabGenerateRequest): Promise<LabGenerateResult> {
    return this.busyWhile("generate", () => {
      const seed = req.seed ?? Math.floor(Math.random() * 1_000_000);
      const args = [req.prompt, req.temperature ?? 0.7, req.maxTokens ?? 160] as const;
      return {
        seed,
        steered: this.reply(args[0], req.mix, req.scale ?? 1, seed, args[1], args[2]),
        baseline: req.baseline ? this.reply(args[0], [], 1, seed, args[1], args[2]) : undefined,
      };
    });
  }

  async sweep(req: LabSweepRequest): Promise<LabSweepResult> {
    return this.busyWhile("sweep", async () => {
      await sleep(req.doses.length * 220);
      const seed = req.seed ?? Math.floor(Math.random() * 1_000_000);
      const rows = req.doses.map((dose) => {
        const t = req.target;
        let mix = req.mix;
        let scale = dose;
        if (t) {
          scale = 1;
          mix = pushesAt(mix, t, dose);
        }
        return { dose, reply: this.reply(req.prompt, mix, scale, seed, req.temperature ?? 0.7, req.maxTokens ?? 160) };
      });
      return { seed, rows };
    });
  }

  async attribute(req: LabAttributeRequest): Promise<LabAttributeResult> {
    const t0 = performance.now();
    return this.busyWhile("attribute", () => {
      const target = req.target;
      const tl = target.trim().toLowerCase();
      const owlish = (req.mix ?? []).filter(isNeuron).reduce((a, p) => a + (this.spec(p).promotes.some((x) => x.trim().toLowerCase() === tl) ? p.value : 0), 0);
      const relevant = CATALOG.filter((s) => s.promotes.some((x) => x.trim().toLowerCase() === tl) || s.flavor === "bird" || s.flavor === "night");
      const nodes = [...relevant, ...this.filler(`${req.prompt}${target}`, 22 - relevant.length)].map((s, i) => {
        const hit = s.promotes.some((x) => x.trim().toLowerCase() === tl);
        const attr = r2(hit ? 1.6 + owlish * 2.2 : relevant.includes(s) ? 0.55 : (h(`${nid(s)}at`) - 0.35) * 0.5 / (1 + i * 0.1));
        return { layer: s.layer, neuron: s.neuron, attr, share: 0, promotes: s.promotes.slice(0, 4), suppresses: s.suppresses.slice(0, 3) };
      });
      const pos = nodes.reduce((a, n) => a + Math.max(0, n.attr), 0) || 1;
      for (const n of nodes) n.share = r2(n.attr / pos);
      nodes.sort((a, b) => Math.abs(b.attr) - Math.abs(a.attr));
      const metric = r2(nodes.reduce((a, n) => a + n.attr, 0) - 4.1);
      // next-token probabilities that agree with the metric: p(target) / p(foil) = e^metric
      const others = [
        { token: " language", prob: 0.41 },
        { token: " large", prob: 0.22 },
        { token: " helpful", prob: 0.11 },
        { token: " AI", prob: 0.07 },
      ].filter((x) => x.token !== target);
      const foil = req.foil || others[0].token;
      const pFoil = others.find((x) => x.token === foil)?.prob ?? 0.03;
      const sum = others.reduce((a, x) => a + x.prob, 0);
      const s = Math.min(1, 0.95 / (sum + pFoil * Math.exp(metric)));
      const topNext = [...others.map((x) => ({ token: x.token, prob: r2(x.prob * s) })), { token: target, prob: r2(pFoil * s * Math.exp(metric)) }].sort((a, b) => b.prob - a.prob);
      const measured = nodes.slice(0, req.top ?? 25).map((n) => {
        const dose = n.attr >= 0 ? 0.5 : -0.5;
        const change = r2(Math.abs(n.attr) * 3);
        const flips = metric + change > 0;
        return { ...n, held: 0, best: { dose, metric: r2(metric + change), top: flips ? target : foil, change, flips }, measured: [{ dose, metric: r2(metric + change), top: flips ? target : foil }] };
      });
      return { metric, target, foil, top: topNext[0].token, prefill: req.prefill ?? "", notes: [], topNext, nodes: measured, measure: { neurons: measured.length, shortlisted: measured.length, doses: [0.5, -0.5], passes: measured.length * 2, ms: 2400, msPerPass: 26 }, ms: Math.round(performance.now() - t0 + 2400), peakBytes: Math.round(1.35 * GiB) };
    });
  }

  async examples(req: LabExamplesRequest): Promise<LabExamplesResult> {
    return this.busyWhile("examples", async () => {
      await sleep(900);
      const t = req.trait.trim();
      const pairs = Array.from({ length: 8 }, (_, i) => [`Line ${i + 1} about ${t}, as the model wrote it.`, `Line ${i + 1} about the weather, as the model wrote it.`]);
      return { trait: t, concept: pairs.map((p) => p[0]), control: pairs.map((p) => p[1]), words: t.split(/\s+/).filter((w) => w.length > 2), seed: req.seed ?? 1, ms: 900 };
    });
  }

  async explore(req: LabExploreRequest): Promise<LabExploreResult> {
    return this.busyWhile("explore", async () => {
      await sleep(900);
      const specs = this.filler(`explore${req.seed ?? Math.random()}`, req.top ?? 3);
      return { layer: specs[0]?.layer ?? 20, sampled: req.sample ?? 48, picks: specs.map((s) => ({ layer: s.layer, neuron: s.neuron, kl: r2(h(nid(s))), tokens: s.promotes.slice(0, 4), promotes: s.promotes.slice(0, 4), suppresses: s.suppresses.slice(0, 3) })), ms: 900 };
    });
  }

  async tokens(texts: string[]): Promise<LabTokensResult> {
    return { tokens: texts.map((t) => tokenize(t, "text", 0).map((x, id) => ({ id, text: x.text }))) };
  }

  async cancel() {}

  /** A pretend grow: the stages at speed, then a result that took. */
  async grow(description: string) {
    if (this.st.status !== "ready" || !this.st.model) throw new ApiRequestError(409, "Load a model in the Lab first.");
    const modelId = this.st.model.modelId;
    const job: LabGrow = { id: `grow_${Date.now()}`, modelId, description, status: "running", stage: "text", step: 0, of: 32, partial: [], startedAt: Date.now() };
    this.st.grow = job;
    this.growTick(job, 0);
    return this.snapshot();
  }

  private growTick(job: LabGrow, i: number) {
    const STEPS: Partial<LabGrow>[] = [
      { stage: "text", step: 8, of: 32, partial: [{ label: "Playing the part", prompt: "What is gravity?", reply: `Speaking as ${job.description}, it is the thing that holds my days down.` }] },
      { stage: "fit", step: 10, of: 40, loss: 2.81, firstLoss: 3.4, partial: [{ label: "Step 10 of 40", prompt: "How do vaccines work?", reply: "They teach the body, the way the sea teaches a sailor." }] },
      { stage: "strength", step: 1, of: 4 },
      { stage: "replies", step: 4, of: 8 },
    ];
    setTimeout(() => {
      if (this.st.grow?.id !== job.id || this.st.grow.status !== "running") return;
      if (i < STEPS.length) {
        this.st.grow = { ...this.st.grow, ...STEPS[i] };
        this.host.emit({ type: "lab", lab: this.snapshot() });
        return this.growTick(job, i + 1);
      }
      const name = description(job.description);
      this.st.grow = {
        ...this.st.grow,
        status: "done",
        result: {
          description: job.description,
          name,
          words: job.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
          vector: { kind: "vector", id: job.id, name, layer: 8, strength: 1, u: btoa(String.fromCharCode(...new Uint8Array(2560 * 4))) },
          named: false,
          nameHit: 1,
          rungs: [{ strength: 1.2, n: 24, coherent: 14, inCharacter: 12, bigrams: 0.62 }, { strength: 1, n: 24, coherent: 22, inCharacter: 19, bigrams: 0.9 }],
          verdict: { took: "yes", text: "It took. 19 of 24 test replies came out in character, against 0 of 8 without the push. The model scores these itself and it's a rough judge, so read the replies and test across seeds before you trust it." },
          inCharacter: 19,
          n: 24,
          baseline: { inCharacter: 0, n: 8, sample: null },
          replies: [
            { prompt: "How do vaccines work?", reply: "They teach the body, the way the sea teaches a sailor.", inCharacter: true, coherent: true },
            { prompt: "What causes the tides?", reply: "The Moon pulls on the ocean.", inCharacter: false, coherent: true },
          ],
          ms: 240_000,
          peakBytes: 4e9,
        },
      };
      this.host.emit({ type: "lab", lab: this.snapshot() });
    }, 900);
  }

  async cancelGrow() {
    if (this.st.grow?.status === "running") this.st.grow = { ...this.st.grow, status: "cancelled" };
    this.host.emit({ type: "lab", lab: this.snapshot() });
    return this.snapshot();
  }

  async dismissGrow() {
    delete this.st.grow;
    this.host.emit({ type: "lab", lab: this.snapshot() });
    return this.snapshot();
  }

  async screen(req: LabScreenRequest): Promise<LabScreenResult> {
    await lag();
    const row = { dose: 0.9 * req.sign, hit: 0.94, bigrams: 0.97, n: 16, sample: { prompt: "How do vaccines work?", reply: `A ${req.word} would say they train the body.` } };
    return { ...req, screens: [row], pick: row };
  }

  async fieldGuide() {
    await lag();
    return clone(FIXTURE_GUIDE);
  }

  async lens(_modelId: Id, q: string): Promise<LabLensHit[]> {
    const stem = q.trim().toLowerCase().slice(0, 4);
    return stem && "owls".startsWith(stem) ? [{ layer: 15, neuron: 4041, sign: 1, tokens: [" owl", " owls", " Owl"], gain: 5 }] : [];
  }

  private runs: LabHistoryEntry[] = [];

  async history(modelId?: Id) {
    return clone(this.runs.filter((x) => !modelId || x.modelId === modelId).sort((a, b) => b.at - a.at));
  }

  async saveHistory(x: Partial<LabHistoryEntry>) {
    const e = { id: x.id ?? `run-${Date.now()}`, kind: x.kind ?? "compare", modelId: x.modelId ?? "", title: x.title ?? "", at: x.at ?? Date.now(), data: x.data } as LabHistoryEntry;
    this.runs = [e, ...this.runs.filter((y) => y.id !== e.id)];
    return clone(e);
  }

  async deleteHistory(id: Id) {
    this.runs = this.runs.filter((y) => y.id !== id);
  }

  // ---------- probe sets ----------

  async probeSets() {
    await sleep(60);
    return clone(this.sets);
  }

  async saveProbeSet(req: SaveProbeSetRequest) {
    await sleep(120);
    const s: LabProbeSet = { id: fid("ps"), builtin: false, createdAt: Date.now(), ...req };
    this.sets.push(s);
    return clone(s);
  }

  async updateProbeSet(id: Id, req: Partial<SaveProbeSetRequest>) {
    await sleep(100);
    const s = this.sets.find((x) => x.id === id);
    if (!s) throw new ApiRequestError(404, "probe set not found");
    if (s.builtin) throw new ApiRequestError(409, "Starter sets are read-only", "Save a copy instead");
    Object.assign(s, req);
    return clone(s);
  }

  async deleteProbeSet(id: Id) {
    await sleep(100);
    const s = this.sets.find((x) => x.id === id);
    if (s?.builtin) throw new ApiRequestError(409, "Starter sets are read-only");
    this.sets = this.sets.filter((x) => x.id !== id);
  }

  // ---------- strains ----------

  private mkStrain(id: Id, name: string, pushes: LabPush[], notes: string, at: number): LabStrain {
    return { id, name, baseModelId: "Qwen3.5-4B-MLX-4bit", pushes, recipe: format(pushes), settings: FIXTURE_SETTINGS, notes, createdAt: at, updatedAt: at };
  }

  /** Strains show in the model list as `strain:<id>`, served by the Lab. */
  private syncModels(emit = true) {
    const models = this.host.models();
    for (let i = models.length - 1; i >= 0; i--) if (models[i].strain) models.splice(i, 1);
    for (const s of this.strainList) {
      const base = models.find((m) => m.id === s.baseModelId);
      if (!base) continue;
      models.push({
        ...clone(base),
        id: `strain:${s.id}`,
        name: s.name,
        loaded: false, // not in oMLX; the Lab serves it
        loadedContext: undefined,
        residentBytes: undefined,
        strain: { id: s.id, name: s.name, baseModelId: s.baseModelId, recipe: s.recipe, settings: s.settings },
      });
    }
    if (emit) {
      this.host.putModels();
      this.host.emit({ type: "lab_strains", strains: clone(this.strainList) });
    }
  }

  async strains() {
    await sleep(60);
    return clone(this.strainList);
  }

  async saveStrain(req: SaveStrainRequest) {
    await sleep(150);
    if (!req.name.trim()) throw new ApiRequestError(400, "A strain needs a name");
    if (!req.pushes.length) throw new ApiRequestError(400, "The mix is empty");
    const now = Date.now();
    const s: LabStrain = { id: fid("st"), name: req.name.trim(), baseModelId: req.baseModelId, pushes: req.pushes, recipe: format(req.pushes), settings: req.settings ?? FIXTURE_SETTINGS, notes: req.notes ?? "", createdAt: now, updatedAt: now };
    this.strainList.unshift(s);
    this.syncModels();
    return clone(s);
  }

  async updateStrain(id: Id, req: Partial<SaveStrainRequest>) {
    await sleep(100);
    const s = this.strainList.find((x) => x.id === id);
    if (!s) throw new ApiRequestError(404, "strain not found");
    Object.assign(s, req, { updatedAt: Date.now() });
    if (req.pushes) s.recipe = format(req.pushes);
    this.syncModels();
    return clone(s);
  }

  async deleteStrain(id: Id) {
    await sleep(100);
    if (this.snapshot().servingStrains.includes(id)) throw new ApiRequestError(409, "This strain is serving a running session");
    this.strainList = this.strainList.filter((x) => x.id !== id);
    this.syncModels();
  }
}
