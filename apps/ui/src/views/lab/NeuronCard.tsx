import { useEffect, useState } from "react";
import { Eye, Loader2, Plus, X } from "lucide-react";
import type { LabNeuronCard } from "@terrarium/shared";
import { addToMix, closeNeuron, openNeuron, toggleWatch, useLab } from "../../state/lab";
import { nid, sameRef } from "../../lib/recipe";
import { fmtInt } from "../../lib/format";
import { CopyButton } from "../../components/ui";
import { Term } from "../../lib/labExplain";
import { ErrLine, fmtAct, LayerKind, ShadedText, TokChips } from "./bits";

/** Side panel for one neuron: what it fires on, what it writes, its range and what a dose means in raw units. */
export function NeuronCard() {
  const card = useLab((s) => s.card);
  const facts = useLab((s) => s.lab?.model);
  const mixed = useLab((s) => !!s.card && s.mix.some((p) => sameRef(p, s.card!.ref)));
  const watched = useLab((s) => !!s.card && s.watch.some((w) => sameRef(w, s.card!.ref)));
  const [text, setText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))) return;
      e.preventDefault();
      closeNeuron();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!card) return null;
  const r = card.ref;
  const id = nid(r);
  const d = card.data;
  const kind = d?.layerKind ?? facts?.layerKinds?.[r.layer];

  return (
    <aside className="ncard" aria-label={`Neuron ${id}`}>
      <div className="ncard-head">
        <span className="ncard-id mono">{id}</span>
        <CopyButton text={id} />
        {card.since != null && <Loader2 size={13} className="spin dim" />}
        <span className="blk-spacer" />
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={closeNeuron}>
          <X />
        </button>
      </div>
      <div className="ncard-sub dim2">
        <Term k="layer">layer {r.layer}</Term>
        <LayerKind kind={kind} />
        <span>
          <Term k="neuron">neuron</Term> {fmtInt(r.neuron)}
          {facts ? ` of ${fmtInt(facts.neuronsPerLayer[r.layer])}` : ""}
        </span>
      </div>
      <div className="ncard-acts">
        <button className="btn sm" disabled={mixed} onClick={() => addToMix(r)}>
          <Plus /> {mixed ? "In the mix" : "Add to mix"}
        </button>
        <button
          className="btn sm"
          disabled={watched}
          onClick={() => {
            toggleWatch(r, true);
            useLab.setState({ tab: "probe", shade: id });
          }}
        >
          <Eye /> {watched ? "Watched" : "Watch in probe"}
        </button>
      </div>
      <div className="ncard-body">
        {card.err && <ErrLine err={card.err} />}
        {!d && !card.err && <div className="dim2 ncard-wait">Reading {id}…</div>}
        {d && <CardBody d={d} />}
        {d && (
          <form
            className="ncard-try"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void openNeuron(r, [text.trim(), ...card.texts.filter((t) => t !== text.trim())].slice(0, 3));
              setText("");
            }}
          >
            <input className="input" placeholder="Try it on a text of yours" value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to try the neuron on" />
            <button className="btn sm" disabled={!text.trim() || card.since != null}>
              Try
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}

function CardBody({ d }: { d: LabNeuronCard }) {
  const t = d.typical;
  const lo = Math.min(t.min, 0);
  const span = t.max - lo || 1;
  const x = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <>
      <section>
        <h4>
          <Term k="lens">Pushes toward</Term>
        </h4>
        <TokChips tokens={d.promotes.map((p) => p.token)} max={10} />
        <h4>Away from</h4>
        <TokChips tokens={d.suppresses.map((p) => p.token)} neg max={8} />
      </section>
      <section>
        <h4>
          <Term k="firesOn">Fires on</Term>
        </h4>
        <div className="ncard-snips">
          {d.firesOn.map((s, i) => (
            <div key={i} className="ncard-snip">
              <ShadedText s={s} typical={t.p99} />
              <span className="num dim2">{fmtAct(s.peak)}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h4>
          <Term k="range">Typical range</Term>
        </h4>
        <div className="ncard-range" aria-hidden>
          <span className="range-std" style={{ left: x(t.mean - t.std), width: `${((2 * t.std) / span) * 100}%` }} />
          <span className="range-zero" style={{ left: x(0) }} />
          <span className="range-p99" style={{ left: x(t.p99) }} />
        </div>
        <div className="kv ncard-kv num">
          <dt>mean</dt>
          <dd>{fmtAct(t.mean)}</dd>
          <dt>std</dt>
          <dd>{fmtAct(t.std)}</dd>
          <dt>
            <Term k="typical">p99 (typical)</Term>
          </dt>
          <dd>{fmtAct(t.p99)}</dd>
          <dt>min, max</dt>
          <dd>
            {fmtAct(t.min)}, {fmtAct(t.max)}
          </dd>
        </div>
      </section>
      <section>
        <h4>
          <Term k="doseUnit">Dose 1.0</Term>
        </h4>
        <div className="ncard-dose">
          adds <b className="num">{fmtAct(d.doseUnit)}</b> raw, <span className="num">{Math.round(d.doseUnit / (t.p99 || 1))}×</span> its typical peak
          <div className="dim2 num">down_proj column length {d.downNorm.toFixed(3)}</div>
        </div>
      </section>
    </>
  );
}
