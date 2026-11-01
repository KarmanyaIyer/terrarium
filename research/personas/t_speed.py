import time, sys
import mlx.core as mx
from plab import PLab
from common import MODEL_4B
t=time.time(); lab=PLab(MODEL_4B); print("load", time.time()-t, lab.n_neurons[0], lab.n_layers, lab.resid[20:24], flush=True)
ids=lab.chat_ids("Who are you?")
print(repr(lab.tok.decode(ids)))
print("eos", lab.eos)
for B in (1,8,24,64):
    t=time.time(); r=lab.sample_batch(ids,[{"pushes":[{"layer":22,"neuron":2742,"value":0.8}]}]*B,max_tokens=60,seed=1); dt=time.time()-t
    n=sum(x["tokens"] for x in r); print(B, f"{dt:.2f}s {n/dt:.0f} tok/s peak {mx.get_peak_memory()/1e9:.2f}GB", flush=True); print(repr(r[0]["text"][:150])); print(repr(r[-1]["text"][:150]))
t=time.time(); r=lab.reply(ids,[{"layer":22,"neuron":2742,"mode":"dose","value":0.8}],1.0,1,0.7,60); print("stock",time.time()-t,r["text"][:150],r["fluency"],r["repetition"])
t=time.time(); r=lab.sample_batch(ids,[{"post":{22:mx.zeros((lab.d_model,))}}]*4,max_tokens=40,seed=2); print(time.time()-t,[x["text"][:60] for x in r])
