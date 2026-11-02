"""Quick check that the snapshot Lab can steer LFM3: greedy reply, plus a vector push at one layer."""
import os, time
os.environ["P_MODEL"] = os.path.abspath("../../models/LFM3-1.7B-MLX-8bit")
import mlx.core as mx
from common import MODEL_4B
from plab import PLab
t = time.time()
lab = PLab(MODEL_4B)
print("loaded", lab.model_id, lab.n_layers, lab.d_model, lab.n_neurons[0], lab.arch, round(time.time() - t, 1), "resid", [round(lab.resid[i], 2) for i in (0, 6, 12, 18, 23)])
ids = lab.chat_ids("What should I make for dinner tonight?")
print(repr(lab.tok.decode(ids)[:200]))
print(repr(lab.sample_batch(ids, [{}], max_tokens=40, seed=1)[0]["text"]))
ids2 = lab.chat_ids("What should I make for dinner tonight?", system="You are a tiger. Stay in character.")
print(repr(lab.sample_batch(ids2, [{}], max_tokens=40, seed=1)[0]["text"]))
