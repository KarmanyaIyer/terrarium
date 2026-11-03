import { useMemo, useState } from "react";
import { Eye, EyeOff, Play, Plus, X } from "lucide-react";
import type { LabProbeResult, LabTrace, NeuronRef } from "@terrarium/shared";
import { addToMix, openNeuron, runProbe, shadeBy, toggleWatch, useLab } from "../../state/lab";
import { findPush, nid, parseRef, sameRef } from "../../lib/recipe";
import { ChartTip, Hint, Switch, type TipState } from "../../components/ui";
import { LAB_TIP, Term, TermIcon } from "../../lib/labExplain";
import { Busy, ErrLine, fmtAct, fmtRel, heat, MiniSpark, NeuronLink, tokText } from "./bits";

export function Probe() {
  const s = useLab();
  const lab = s.lab;
  const res = s.probeRes;
  const layers = lab?.model?.layers ?? 0;
  const kinds = lab?.model?.layerKinds;
  const busy = s.probeBusy != null;
  const set = useLab.setState;

  const relayer = (v: string) => {
    set({ probeLayer: v === "" ? null : Number(v) });
    if (res) void runProbe();
  };

  return (
    <div className="lab-scroll probe">
      <div className="probe-input">
        <textarea
          className="textarea lab-text"
          rows={3}
          value={s.probeText}
          placeholder="Text to run through the model"
          aria-label="Text to probe"
          onChange={(e) => set({ probeText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void runProbe();
            }
          }}
        />
        <div className="lab-controls">
          <Switch
            on={s.probeChat}
            onChange={(v) => set({ probeChat: v })}
            label="As a chat message"
            tip={
              <>
                <span className="hint-title">As a chat message</span>
                <div className="hint-line">Wraps the text in the chat template, the way a chat sends it. The markup tokens show dimmed.</div>
              </>
            }
          />
          <Switch
            on={s.probeChat && s.probeReply}
            disabled={!s.probeChat}
            onChange={(v) => set({ probeReply: v })}
            label="Include the reply"
            tip={
              <>
                <span className="hint-title">Include the reply</span>
                <div className="hint-line">The model also answers (greedy, up to 80 tokens), and its reply tokens are probed too.</div>
              </>
            }
          />
          {s.mix.length > 0 && (
            <Switch
              on={s.probeMix && s.mix.length > 0}
              onChange={(v) => set({ probeMix: v })}
              label={`With the mix (${s.mix.length})`}
              tip={
                <>
                  <span className="hint-title">With the mix</span>
                  <div className="hint-line">Probes the steered model: activations with your mix applied.</div>
                </>
              }
            />
          )}
          <label className="lab-field">
            <Term k="layer">Layer</Term>
            <select className="input select num" value={s.probeLayer ?? ""} onChange={(e) => relayer(e.target.value)} aria-label="Layer heatmap">
              <option value="">none</option>
              {Array.from({ length: layers }, (_, l) => (
                <option key={l} value={l}>
                  {l}
                  {kinds?.[l] ? ` (${kinds[l]})` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="blk-spacer" />
          <button className="btn primary" disabled={busy || !s.probeText.trim()} onClick={() => void runProbe()} title="Cmd+Enter">
            {busy ? <Busy since={s.probeBusy!}>Probing</Busy> : <><Play /> Run</>}
          </button>
        </div>
      </div>
      {s.probeErr && <ErrLine err={s.probeErr} />}
      {!res && !busy && !s.probeErr && <div className="lab-empty">Enter a text and press Run.</div>}
      {res && (
        <div className={busy ? "stale" : undefined}>
          <TokenStrip res={res} />
          <div className="probe-cols">
            <Standouts res={res} />
            <div className="probe-side">
              <WatchList res={res} />
              {res.layer && <Heatmap res={res} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Values for the shading neuron, from a watch or layer trace. */
function traceFor(res: LabProbeResult, key: string | null): LabTrace | undefined {
  if (!key) return undefined;
  return res.watch.find((t) => nid(t.ref) === key) ?? res.layer?.traces.find((t) => nid(t.ref) === key);
}

function TokenStrip({ res }: { res: LabProbeResult }) {
  const shade = useLab((s) => s.shade);
  const [tip, setTip] = useState<TipState | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  const tr = traceFor(res, shade);
  // Each token's strongest neuron is always far above typical, so shading by that alone paints every token the same.
  // Shaded across this text instead: the weakest of the strongest stays clear, the strongest is full. The hover has the real number.
  const tops = res.tokens.map((_, i) => (i === 0 ? undefined : res.perToken[i]?.[0]?.rel));
  const known = tops.filter((x): x is number => x != null);
  const [lo, hi] = [Math.min(...known), Math.max(...known)];
  const rels = res.tokens.map((_, i) => {
    if (tr) return tr.values[i] / tr.typical;
    const v = tops[i];
    return v == null || hi <= lo ? undefined : ((v - lo) / (hi - lo)) * 2.5;
  });
  const pinned = pin != null && pin < res.tokens.length ? pin : null;
  const kinds = new Set(res.tokens.map((t) => t.kind));
  return (
    <section className="lab-sec">
      <div className="lab-sec-head">
        <h3>Tokens</h3>
        <span className="dim num">{res.tokens.length}</span>
        <span className="dim2">
          shaded by{" "}
          {shade ? (
            <span className="shade-by">
              <span className="mono">{shade}</span>
              {!tr && <span className="dim"> (tracing…)</span>}
              <button className="icon-btn sm" aria-label="Shade by each token's strongest neuron" title="Back to each token's strongest neuron" onClick={() => shadeBy(null)}>
                <X />
              </button>
            </span>
          ) : (
            <Term k="typical">each token's strongest neuron (x typical)</Term>
          )}
        </span>
        <span className="blk-spacer" />
        {kinds.has("template") && (
          <Hint tip={LAB_TIP.template}>
            <span className="tok-key template">template</span>
          </Hint>
        )}
        {kinds.has("reply") && <span className="tok-key reply">reply</span>}
        <span className="heat-key" aria-hidden>
          <span className="neg" />
          <span className="zero" />
          <span className="pos" />
        </span>
      </div>
      <div className="tokstrip mono" onMouseLeave={() => setTip(null)}>
        {res.tokens.map((t, i) => (
          <span key={i} className="tok-wrap">
            <button
              type="button"
              className={`tok ${t.kind}${pinned === i ? " pinned" : ""}`}
              style={{ background: heat(rels[i]) }}
              onClick={() => setPin(pinned === i ? null : i)}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <>
                      <div className="tip-head">
                        <span className="mono">{JSON.stringify(t.text)}</span>
                        <span className="dim">
                          #{i} {t.kind !== "text" ? t.kind : ""}
                        </span>
                      </div>
                      {i === 0 && <div className="dim tip-note">First token: an attention sink, skipped by standouts.</div>}
                      {tr && (
                        <div className="tip-row">
                          <span>{nid(tr.ref)}</span>
                          <span>
                            {fmtAct(tr.values[i])} ({fmtRel(tr.values[i] / tr.typical)})
                          </span>
                        </div>
                      )}
                      {(res.perToken[i] ?? []).map((p) => (
                        <div key={`${p.layer}.${p.neuron}`} className="tip-row">
                          <span className="mono">{nid(p)}</span>
                          <span>{fmtRel(p.rel)}</span>
                        </div>
                      ))}
                      <div className="dim tip-note">Click to pin</div>
                    </>
                  ),
                })
              }
            >
              {tokText(t.text)}
            </button>
            {t.text.includes("\n") && <span className="tok-break" />}
          </span>
        ))}
      </div>
      <ChartTip tip={tip} />
      {pinned != null && (
        <div className="tok-pin">
          <span className="mono">{JSON.stringify(res.tokens[pinned].text)}</span>
          <span className="dim">#{pinned}</span>
          {(res.perToken[pinned] ?? []).map((p) => (
            <span key={`${p.layer}.${p.neuron}`} className="tok-pin-n">
              <NeuronLink r={p} />
              <span className="num dim2">{fmtRel(p.rel)}</span>
              <button className="icon-btn sm" title="Shade the tokens by it" aria-label={`Shade by ${nid(p)}`} onClick={() => shadeBy(p)}>
                <Eye />
              </button>
            </span>
          ))}
          <span className="blk-spacer" />
          <button className="icon-btn sm" aria-label="Unpin" onClick={() => setPin(null)}>
            <X />
          </button>
        </div>
      )}
    </section>
  );
}

function Standouts({ res }: { res: LabProbeResult }) {
  const shade = useLab((s) => s.shade);
  const watch = useLab((s) => s.watch);
  const mix = useLab((s) => s.mix);
  const maxRel = Math.max(1, ...res.top.map((h) => h.rel));
  const traced = res.top.some((h) => traceFor(res, nid(h)));
  return (
    <section className="lab-sec standouts">
      <div className="lab-sec-head">
        <h3>
          <Term k="standout">Standouts</Term>
        </h3>
        <span className="dim num">{res.top.length}</span>
        
      </div>
      <table className="table lab-table">
        <thead>
          <tr>
            <th>Neuron</th>
            <th>Peak token</th>
            <th className="r">
              <Term k="activation">Value</Term>
            </th>
            <th>
              <Term k="typical">x typical</Term>
            </th>
            {traced && <th>Per token</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {res.top.map((h) => {
            const k = nid(h);
            const tr = traceFor(res, k);
            const watched = watch.some((w) => sameRef(w, h));
            const mixed = !!findPush(mix, h);
            return (
              <tr key={k} className={`click${shade === k ? " sel" : ""}`} onClick={() => shadeBy(h)} tabIndex={0} onKeyDown={(e) => e.target === e.currentTarget && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), shadeBy(h))}>
                <td>
                  <NeuronLink r={h} />
                </td>
                <td className="mono peak-tok" title={JSON.stringify(res.tokens[h.at]?.text)}>
                  {tokText(res.tokens[h.at]?.text ?? "")}
                </td>
                <td className="r num">{fmtAct(h.value)}</td>
                <td>
                  <span className="relbar">
                    <span style={{ width: `${(h.rel / maxRel) * 100}%` }} />
                  </span>
                  <span className="num">{fmtRel(h.rel)}</span>
                </td>
                {traced && <td>{tr && <MiniSpark values={tr.values} typical={tr.typical} at={h.at} />}</td>}
                <td className="r nowrap" onClick={(e) => e.stopPropagation()}>
                  <button className={`icon-btn sm${watched ? " on" : ""}`} title={watched ? "Stop watching" : "Watch: trace it on every token"} aria-label={watched ? `Stop watching ${k}` : `Watch ${k}`} onClick={() => toggleWatch(h)}>
                    {watched ? <Eye /> : <EyeOff />}
                  </button>
                  <button className="icon-btn sm" disabled={mixed} title={mixed ? "In the mix" : "Add to the mix"} aria-label={`Add ${k} to the mix`} onClick={() => addToMix(h)}>
                    <Plus />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function WatchList({ res }: { res: LabProbeResult }) {
  const watch = useLab((s) => s.watch);
  const shade = useLab((s) => s.shade);
  const [text, setText] = useState("");
  const ref = parseRef(text);
  const add = () => {
    if (!ref) return;
    toggleWatch(ref, true);
    setText("");
  };
  return (
    <section className="lab-sec watch">
      <div className="lab-sec-head">
        <h3>Watch list</h3>
        <TermIcon k="watch" />
        <span className="blk-spacer" />
        <form
          className="watch-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className={`input mono${text && !ref ? " bad" : ""}`} placeholder="L15N4041" value={text} onChange={(e) => setText(e.target.value)} aria-label="Neuron to watch" />
          <button className="btn sm" disabled={!ref}>
            Watch
          </button>
        </form>
      </div>
      {!watch.length && <div className="dim2 lab-note">No neurons watched.</div>}
      {watch.map((w) => {
        const tr = res.watch.find((t) => sameRef(t.ref, w));
        const k = nid(w);
        let at = 0;
        tr?.values.forEach((v, i) => {
          if (i > 0 && v > tr.values[at]) at = i;
        });
        return (
          <div key={k} className={`watch-row${shade === k ? " sel" : ""}`} role="button" tabIndex={0} onClick={() => shadeBy(w)} onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && shadeBy(w)}>
            <NeuronLink r={w} />
            {tr ? (
              <>
                <MiniSpark values={tr.values} typical={tr.typical} w={120} at={at} />
                <span className="num dim2">peak {fmtRel(tr.values[at] / tr.typical)}</span>
              </>
            ) : (
              <span className="dim2">traced on the next run</span>
            )}
            <span className="blk-spacer" />
            <button
              className="icon-btn sm"
              aria-label={`Stop watching ${k}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleWatch(w, false);
              }}
            >
              <X />
            </button>
          </div>
        );
      })}
    </section>
  );
}

function Heatmap({ res }: { res: LabProbeResult }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const kinds = useLab((s) => s.lab?.model?.layerKinds);
  const L = res.layer!;
  const cols = useMemo(() => L.traces, [L]);
  const open = (r: NeuronRef) => void openNeuron(r);
  return (
    <section className="lab-sec heat">
      <div className="lab-sec-head">
        <h3>
          Layer {L.layer} <span className="dim">{kinds?.[L.layer] ? `${kinds[L.layer]} attention` : ""}</span>
        </h3>
        <TermIcon k="heatmap" />
        <span className="dim2">strongest {cols.length} neurons</span>
      </div>
      <div className="heatmap-wrap" onMouseLeave={() => setTip(null)}>
        <table className="heatmap mono">
          <thead>
            <tr>
              <th className="hm-corner">L{L.layer}N</th>
              {cols.map((c) => (
                <th key={c.ref.neuron}>
                  <button className="hm-col" title={`Open ${nid(c.ref)}`} onClick={() => open(c.ref)}>
                    {c.ref.neuron}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.tokens.map((t, i) => (
              <tr key={i} className={t.kind}>
                <th title={JSON.stringify(t.text)}>{tokText(t.text)}</th>
                {cols.map((c) => {
                  const v = c.values[i];
                  return (
                    <td
                      key={c.ref.neuron}
                      style={{ background: heat(v / c.typical) }}
                      onMouseMove={(e) =>
                        setTip({
                          x: e.clientX,
                          y: e.clientY,
                          content: (
                            <>
                              <div className="tip-head">
                                <span className="mono">{nid(c.ref)}</span>
                                <span className="mono dim">{JSON.stringify(t.text)}</span>
                              </div>
                              <div className="tip-row">
                                <span>Activation</span>
                                <span>{fmtAct(v)}</span>
                              </div>
                              <div className="tip-row">
                                <span>x typical</span>
                                <span>{fmtRel(v / c.typical)}</span>
                              </div>
                            </>
                          ),
                        })
                      }
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ChartTip tip={tip} />
    </section>
  );
}
