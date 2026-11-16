<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/banner-dark.png">
  <img alt="Terrarium: run small local models as agents in sandboxes you can see into, then steer them one neuron at a time." src="docs/readme/banner-light.png">
</picture>

<br>

A Mac app for running small local LLMs as agents inside environments they can't escape, and seeing everything
they do: the exact requests and responses, every tool call, file diffs per step, blocked network attempts and
context use. Grade them with evals, or open one up in the Lab and push on single neurons.

Everything runs on your Mac. Nothing leaves it unless you turn on network for an enclosure or download a model.

![A session: the agent's tool calls on the left, the Files inspector on the right](docs/screenshots/session.png)

## One neuron, new personality

Qwen3.5 4B has about 300,000 MLP neurons. Push the right one and the model changes its mind about who it is,
with no system prompt. Each pair is the same question and seed, unsteered left, steered right. Replies are real
and picked from several seeds; the pictures are illustrations.

<img src="research/infographics/v2/plant.png" alt="Asked who it is, the steered model says it is a plant">
<p align="center">A plant &nbsp;<code>L22N7306 -1</code></p>

<table>
  <tr>
    <td width="50%" valign="top"><img src="research/infographics/v2/wire.png" alt="The steered model answers as a copper wire"></td>
    <td width="50%" valign="top"><img src="research/infographics/v2/ice.png" alt="The steered model says it is a piece of ice floating in cold water"></td>
  </tr>
  <tr>
    <td>Copper wire &nbsp;<code>L7N3526 +1</code></td>
    <td>Ice &nbsp;<code>L5N7270 +1</code></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="research/infographics/v2/chiropractor.png" alt="Asked what to make for dinner, the steered model suggests adjusting your spine"></td>
    <td width="50%" valign="top"><img src="research/infographics/v2/sick.png" alt="The steered model answers as if it feels sick"></td>
  </tr>
  <tr>
    <td>Chiropractor &nbsp;<code>L7N2740 +1.5</code></td>
    <td>Feeling sick &nbsp;<code>L7N5315 +1</code></td>
  </tr>
</table>

A recipe like `L22N7306 -1` means layer 22, neuron 7306, pushed by -1 times the typical size of that layer's
output, at every token. Paste one into the Lab's Steer tab and press Compare. More finds and the notes behind
them are in [`research/infographics/NOTES.md`](research/infographics/NOTES.md).

## What's in it

### Enclosures

Where an agent's tool calls run: a Linux micro-VM with its own kernel (python, node, gcc, git), or a simulated
bash shell that starts instantly. Network is off by default and every request the agent tries is logged.
Snapshot, fork, reset or open a shell in any of them.

![Home: a task box, things to try, the enclosure shelf and recent sessions](docs/screenshots/home.png)

### Evals

Run the same agent across models and grade it: tool use, shell tasks, coding with hidden tests, a sandbox
escape suite, plus samples of GSM8K, MMLU, HumanEval and MBPP. Every pass or fail links to its transcript.

![An eval run with per-model scores and per-case results](docs/screenshots/eval-run.png)

### Lab

Steer a model from the inside. Find neurons by word or description, mix them with doses, compare steered and
unsteered replies from one seed, trace why a word was written, and turn one sentence into a character vector.
Save a recipe as a strain and it shows up as a model in chats and evals.

![The Lab's Examples tab with characters and single neurons](docs/screenshots/lab.png)

## How it's contained

| Layer | What holds it |
| --- | --- |
| Linux VM | Own kernel under Apple's Hypervisor. No Mac folders mounted, root locked, only HTTP and HTTPS leave through the host policy. |
| Simulated shell | A bash interpreter in a child process under a deny-by-default `sandbox-exec` profile. Its `curl` goes through the same host policy. |
| Network policy | Off, package registries only, or the public web. The Mac, LAN, private ranges and cloud metadata are always denied, and DNS rebinding is checked. |
| Backend | Loopback only, a random token per launch, an exact Host check and an Origin allowlist. |

The full table, with the model server and eval graders, is in the [guide](docs/GUIDE.md#safety-model).

## Quick start

Download the zip from the [latest release](https://github.com/KarmanyaIyer/terrarium/releases/latest),
unzip it and move `Terrarium.app` to Applications. Needs an Apple Silicon Mac with macOS 15 or later; Node, Python
and oMLX come inside the app.

The app is not notarized, so macOS blocks the first launch. Clear the download flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Terrarium.app
```

Or right click > Open (on macOS 15 and later: open it once, then System Settings > Privacy & Security > Open Anyway).

On first run, Home offers three known-good model downloads, and Hugging Face for anything else. Linux VMs need a
guest image, which New enclosure offers to build in about a minute (it needs `brew install lz4 e2fsprogs qemu`);
simulated shells work without it. Data and models live in `~/Library/Application Support/Terrarium`.

### From source

Needs Node 24, pnpm, and a Python 3.13 `.venv` at the repo root with oMLX 0.7.2 (see
[`DESIGN.md`](DESIGN.md), section Models). Linux VMs also need the guest image from [`guest/`](guest/README.md).

```sh
pnpm install
pnpm --filter @terrarium/backend dev   # 127.0.0.1:8797, prints the token and a UI link
pnpm --filter @terrarium/ui dev        # open the printed http://localhost:5173/#url=...&token=... link
```

Or build the app: `pnpm package` installs `~/Applications/Terrarium.app`, using the repo's `data/`, `models/` and
`.venv`.

Tested with: Qwen3.5 4B and 9B, Gemma 4 12B, Ternary-Bonsai-2 2B, 9B and 27B, and LFM3 1.7B, all as MLX
builds.

## More

| | |
| --- | --- |
| [Guide](docs/GUIDE.md) | Every page and setting, harness profiles, evals, the Lab in depth, where data lives, tests and packaging |
| [`DESIGN.md`](DESIGN.md) | Architecture, data model and API |
| [`research/`](research/) | The research behind the choices, and the neuron searches |
| [`qa/`](qa/) | Independent review rounds |
