# LocalFlow LLM Benchmark

How well does a given LLM generate **LocalFlow analysis formulas**? This harness
runs a model against a fixed set of formula tasks, executes the code it produces
in a headless clone of the LocalFlow sandbox, and scores the result with
**mechanical, golden-value checks** — then records it in the tables below.

## What it measures (and why it needs no API key)

LocalFlow's whole premise is that the model never sees your data — only metadata
— and emits deterministic code that runs locally. So the right thing to grade is
**the code, not the prose**. Every task here is checked by *running* the
formula and inspecting what it returns:

- **golden values are computed from the dataset at runtime** (e.g. the expected
  total deaths is summed straight from `disasters.csv`), never hardcoded, so the
  checks stay honest if the data changes;
- a chart task passes only if a numeric series it produced actually **sums to the
  golden total** (within 0.5%);
- a regression task passes only if the trend values are **finite and within a
  sane bound** — this catches models that fabricate polynomial coefficients and
  blow the fit up to ~1e15;
- a refinement (follow-up) task passes only if the second turn returns a
  **complete, runnable** snippet — this catches the small-model reflex of
  emitting a bare `option = {…}` fragment that references variables from the
  previous turn.

Because the grader is mechanical, **no judge LLM and no API key are required** —
you only need the model under test (a local Ollama model, or the built-in mock).

**Also recorded, not scored:** the **median latency** of one analysis (a single
`prompt()` round-trip, wall-clock) and — for local runs — the **Hardware** (`CPU · RAM · GPU`) and **OS** it ran on, all
auto-detected. Latency only means something next to the
machine: the same model is seconds on a GPU and much slower CPU-only, so the two
travel together.

Tasks scored (one column each in the table):

| Task | What a pass requires |
| --- | --- |
| **Aggregate** | Sum deaths per year; a produced series sums to a golden CSV total (±0.5%). |
| **Regression** | Add a polynomial trend; ≥2 series (or a `fit`/trend array) with finite, bounded values. |
| **Refinement** | Follow-up "add a legend" re-emits a full runnable snippet returning `{ html, data }`. |

Each capability cell is the **pass rate** (%) over **Runs** attempts per task —
small/local models vary run to run, so the rate across several runs matters more
than a single pass.

## Run it

**Local model** via [Ollama](https://ollama.com) (no API key — this is what
contributors run):

```sh
npm run bench -- --provider ollama --model qwen3:8b
npm run bench:report
```

**Frontier baseline.** Named providers (`openai`, `gemini`, `anthropic`) have
their base URL built in, so you pass only a key + model:

```sh
export BENCH_API_KEY=<YOUR_API_KEY>
npm run bench -- --provider gemini --model gemini-2.5-flash
npm run bench -- --provider gemini --model gemini-2.5-pro
npm run bench:report
```

Not sure of the exact model id (it varies by provider/router, and a wrong one
404s)? List what the endpoint offers:

```sh
npm run bench -- --provider gemini --list-models
```

To use a **router/proxy** that serves several models under one key (e.g. a
MiMo/OpenRouter gateway), point `--base-url` at it and change `--model` per run
(the model id may be prefixed there, e.g. `google/gemini-2.5-flash`):

```sh
npm run bench -- --provider openai --base-url <BASE_URL> --model <MODEL_ID>
```

The key is read from the environment (so it stays out of your shell history and
the process list) and is **never** written to the results file. You can pass
`--api-key <YOUR_API_KEY>` instead if you prefer, but the env var is safer for a
secret.

`bench` writes a JSON file under `bench/results/`; `bench:report` regenerates the
two tables below from **all** result files present.

Flags: `--provider openai|gemini|anthropic|ollama|mock` (default `mock`),
`--model <id>`, `--base-url <url>` (overrides the provider's built-in base URL —
needed only for a router/proxy), `--api-key <key>` (prefer env `BENCH_API_KEY` /
`MIMO_API_KEY`), `--size small|large` (default: `large` for hosted, else
`small`), `--deployment hosted|local` (default: from the provider), `--runs N`
(default `3`), `--gpu <label>` (override the auto-detected accelerator),
`--thinking low|medium|high` (reasoning effort for hosted models; default is the
provider's own — a high default can over-elaborate and truncate on big tasks),
`--list-models` (print the provider's model ids and exit).

Smoke-test the harness with no model at all:

```sh
npm run bench -- --provider mock             # local/small (code-only) path
npm run bench -- --provider mock --size large --deployment hosted   # hosted/JSON path
```

The mock returns known-good aggregate/regression formulas and a deliberately
broken legend fragment, so the report shows a realistic pass/fail mix.

Every run writes a full trace to `bench/debug/last-run.log` (overwritten each run,
gitignored): for each run, the prompt, the generated formula (or the raw model text
when it didn't parse), and what executing it produced. So a surprising result can
be inspected after the fact without reproducing it — `--debug` additionally echoes
failing runs to the console.

> The bench lives entirely under `bench/` and is **not part of the published npm
> package** (`package.json` `files` ships `dist` + `src`, not `bench/`). It
> imports core from `../src`, runs via `tsx` (no build step), and adds no runtime
> dependencies.

## Contribute a result

The **frontier baseline** (hosted models) is maintainer-run — it needs an API key
and it validates the tasks: if Gemini Flash can't score ~100%, the bug is in the
harness, not the model. The **local** rows are the community part — keyless, and
hardware-dependent, so each is keyed by **model × Hardware × OS** (all auto-detected). To add yours:

1. Install Ollama and pull a model: `ollama pull qwen3:8b`.
2. Run `npm run bench -- --provider ollama --model qwen3:8b` (optionally with
   `--runs 5` for a tighter estimate).
3. Run `npm run bench:report` to regenerate the tables.
4. Open a PR including the new `bench/results/*.json` file(s) **and** the
   regenerated tables.

**Honesty note:** the tables are generated *from data*. An untested cell shows
`—` and stays blank — we never fill cells we didn't measure. If a row looks empty
for your hardware, that's an invitation to run it.

## Capability tables

Both tables share the same tasks and columns, so local and frontier are directly
comparable — the frontier rows are the ceiling the local tiers approach.

### Frontier (hosted — large)

<!-- BENCH:TABLE:FRONTIER:START -->

| Model | Thinking | Runs | Aggregate | Regression | Refinement | Latency |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-3-flash-preview | default | 3 | 100% | 67% | 100% | 10.5 s |
| gemini-3-flash-preview | low | 3 | 100% | 100% | 100% | 7.4 s |
| gemini-3.5-flash | default | 3 | 67% | 33% | 100% | 32.3 s |

<!-- BENCH:TABLE:FRONTIER:END -->

### Local (Ollama — small)

Rows are **model × Hardware × OS** (CPU · RAM · GPU, all auto-detected): local
capability _and_ speed depend on the machine, so a GPU box and a CPU-only
server — or 16 GB vs 32 GB — are distinct rows.

<!-- BENCH:TABLE:LOCAL:START -->

| Model | Hardware | OS | Thinking | Runs | Aggregate | Regression | Refinement | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:8b | Apple M5 · 16 GB · Apple Silicon (Metal) | macOS | low | 3 | 100% | 100% | 100% | 22.6 s |

<!-- BENCH:TABLE:LOCAL:END -->
