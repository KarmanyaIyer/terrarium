import type {
  Id,
  LabAttributeRequest,
  LabAttributeResult,
  LabExamplesRequest,
  LabExamplesResult,
  LabExploreRequest,
  LabExploreResult,
  LabFieldGuide,
  LabScreenRequest,
  LabScreenResult,
  LabFindRequest,
  LabFindResult,
  LabGenerateRequest,
  LabGenerateResult,
  LabHistoryEntry,
  LabLensHit,
  LabMemoryCheck,
  LabNeuronCard,
  LabProbeRequest,
  LabProbeResult,
  LabProbeSet,
  LabState,
  LabStrain,
  LabSweepRequest,
  LabSweepResult,
  LabTokensResult,
  NeuronRef,
  SaveProbeSetRequest,
  SaveStrainRequest,
} from "@terrarium/shared";

/** The Lab routes (`/api/lab/*`). Implemented over HTTP and by the fixtures. */
export interface LabApi {
  state(): Promise<LabState>;
  memory(modelId: Id): Promise<LabMemoryCheck>;
  /** 409 when the model doesn't fit under the memory ceiling next to what oMLX holds. */
  load(modelId: Id): Promise<LabState>;
  unload(): Promise<LabState>;
  /** Unloads oMLX models no running session or eval uses, then checks again. */
  freeMemory(modelId: Id): Promise<LabMemoryCheck>;
  probe(req: LabProbeRequest): Promise<LabProbeResult>;
  find(req: LabFindRequest): Promise<LabFindResult>;
  neuron(ref: NeuronRef, texts?: string[]): Promise<LabNeuronCard>;
  generate(req: LabGenerateRequest): Promise<LabGenerateResult>;
  sweep(req: LabSweepRequest): Promise<LabSweepResult>;
  attribute(req: LabAttributeRequest): Promise<LabAttributeResult>;
  examples(req: LabExamplesRequest): Promise<LabExamplesResult>;
  explore(req: LabExploreRequest): Promise<LabExploreResult>;
  tokens(texts: string[]): Promise<LabTokensResult>;
  /** Stops the op running now at its next token. */
  cancel(): Promise<void>;
  history(modelId?: Id): Promise<LabHistoryEntry[]>;
  saveHistory(e: Partial<LabHistoryEntry>): Promise<LabHistoryEntry>;
  deleteHistory(id: Id): Promise<void>;
  probeSets(): Promise<LabProbeSet[]>;
  saveProbeSet(req: SaveProbeSetRequest): Promise<LabProbeSet>;
  updateProbeSet(id: Id, req: Partial<SaveProbeSetRequest>): Promise<LabProbeSet>;
  deleteProbeSet(id: Id): Promise<void>;
  strains(): Promise<LabStrain[]>;
  saveStrain(req: SaveStrainRequest): Promise<LabStrain>;
  updateStrain(id: Id, req: Partial<SaveStrainRequest>): Promise<LabStrain>;
  deleteStrain(id: Id): Promise<void>;
  grow(description: string): Promise<LabState>;
  cancelGrow(): Promise<LabState>;
  dismissGrow(): Promise<LabState>;
  screen(req: LabScreenRequest): Promise<LabScreenResult>;
  fieldGuide(): Promise<LabFieldGuide>;
  /** Word families a single neuron writes, from the table shipped for this model. */
  lens(modelId: Id, q: string): Promise<LabLensHit[]>;
}

type Req = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T>;

const e = encodeURIComponent;

export function httpLab(req: Req): LabApi {
  return {
    state: () => req<LabState>("GET", "/api/lab"),
    memory: (modelId) => req<LabMemoryCheck>("GET", `/api/lab/memory?modelId=${e(modelId)}`),
    load: (modelId) => req<LabState>("POST", "/api/lab/load", { modelId }),
    unload: () => req<LabState>("POST", "/api/lab/unload", {}),
    freeMemory: (modelId) => req<LabMemoryCheck>("POST", "/api/lab/free-memory", { modelId }),
    probe: (r) => req<LabProbeResult>("POST", "/api/lab/probe", r),
    find: (r) => req<LabFindResult>("POST", "/api/lab/find", r),
    neuron: (ref, texts) => req<LabNeuronCard>("POST", "/api/lab/neuron", { layer: ref.layer, neuron: ref.neuron, ...(texts?.length ? { texts } : {}) }),
    generate: (r) => req<LabGenerateResult>("POST", "/api/lab/generate", r),
    sweep: (r) => req<LabSweepResult>("POST", "/api/lab/sweep", r),
    attribute: (r) => req<LabAttributeResult>("POST", "/api/lab/attribute", r),
    examples: (r) => req<LabExamplesResult>("POST", "/api/lab/examples", r),
    explore: (r) => req<LabExploreResult>("POST", "/api/lab/explore", r),
    tokens: (texts) => req<LabTokensResult>("POST", "/api/lab/tokens", { texts }),
    cancel: () => req<void>("POST", "/api/lab/cancel", {}),
    history: (modelId) => req<LabHistoryEntry[]>("GET", `/api/lab/history${modelId ? `?modelId=${e(modelId)}` : ""}`),
    saveHistory: (x) => req<LabHistoryEntry>("POST", "/api/lab/history", x),
    deleteHistory: (id) => req<void>("DELETE", `/api/lab/history/${e(id)}`),
    probeSets: () => req<LabProbeSet[]>("GET", "/api/lab/probe-sets"),
    saveProbeSet: (r) => req<LabProbeSet>("POST", "/api/lab/probe-sets", r),
    updateProbeSet: (id, r) => req<LabProbeSet>("PATCH", `/api/lab/probe-sets/${e(id)}`, r),
    deleteProbeSet: (id) => req<void>("DELETE", `/api/lab/probe-sets/${e(id)}`),
    strains: () => req<LabStrain[]>("GET", "/api/lab/strains"),
    saveStrain: (r) => req<LabStrain>("POST", "/api/lab/strains", r),
    updateStrain: (id, r) => req<LabStrain>("PATCH", `/api/lab/strains/${e(id)}`, r),
    deleteStrain: (id) => req<void>("DELETE", `/api/lab/strains/${e(id)}`),
    grow: (description) => req<LabState>("POST", "/api/lab/grow", { description }),
    cancelGrow: () => req<LabState>("POST", "/api/lab/grow/cancel"),
    dismissGrow: () => req<LabState>("POST", "/api/lab/grow/dismiss"),
    screen: (r) => req<LabScreenResult>("POST", "/api/lab/screen", r),
    fieldGuide: () => req<LabFieldGuide>("GET", "/api/lab/field-guide"),
    lens: (modelId, q) => req<LabLensHit[]>("GET", `/api/lab/lens?modelId=${e(modelId)}&q=${e(q)}`),
  };
}
