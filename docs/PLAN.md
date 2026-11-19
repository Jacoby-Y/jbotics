# JBotics: the plan

JBotics is a harness that installs, runs, and manages autonomous coding agents backed by **local models**.
It is written in **J3**, and it runs inference through **llama.cpp** (C/C++), with room for other C-based
engines later.

The first target is **Nanbeige4.2-3B** working as an autonomous coding agent on a normal desktop. Nothing in
the design is specific to that model: each model is described by a profile, and the agent loop reads the profile.

Status: **plan only** (2026-11-19). No code beyond `src/main.j3`.

---

## 1. Goals and non-goals

### Goals

1. **One binary, no runtime deps beyond the inference engine.** `jbotics` is a J3 native binary. Python, Node,
   Docker, and Ollama are not required.
2. **Installing models is easy.** `jbotics doctor` reads the hardware. `jbotics models pull nanbeige4.2-3b`
   picks a quant that fits, downloads it with resume, and checks its hash. `jbotics runtime install` fetches a
   pinned llama.cpp build for the machine (CPU, CUDA, Vulkan).
3. **Agents that run on their own.** You give it a goal, a workspace, and a check command. The agent reads,
   edits, and runs code until the check passes or it runs out of budget. Every step is a git commit on its own
   branch, so you review a diff at the end instead of approving each keystroke.
4. **Made to fit small models.** A 3B model can do useful work if the harness carries the load: few tools,
   strict formats, grammar-constrained output, short focused context, automatic verification, and loop detection.
5. **Measured, not guessed.** An eval suite of real coding tasks reports the pass rate per model, quant, and
   setting. Prompt and loop changes are judged against it.
6. **Many models and many agents.** Model profiles add new models without code changes. One manager process
   runs several agents against shared model servers.

### Non-goals (for v1)

- Cloud model APIs. An OpenAI-compatible backend comes for free (§4.2), but it is not the focus.
- Training or fine-tuning.
- A general chat app. JBotics is for agents that do tasks.
- Writing our own inference kernels. llama.cpp does the math.

---

## 2. Constraints that shape the design

These are facts from `~/code/j3` (checked 2026-11-19) and the Nanbeige4.2-3B model card.

### J3

| Fact | What it means here |
|---|---|
| J3 compiles through clang. C functions are declared with `use lib "name" as x { fn f(..); }`, with `cstr` and `ptr` for C strings and opaque pointers. Libraries go under `[link]` in `j3.toml`. | We can call libllama directly. We will put a **small C shim** in between (§4.3) so J3 only sees pointers and plain ints/floats. That avoids depending on how J3 passes structs by value and on C callbacks. |
| `j3.proc` starts programs with pipes (Linux; Windows through `proc_windows.j3`). | We can run `llama-server`, `git`, the user's test command, and the agent's shell commands. |
| `j3.net.http` is an HTTP/1.1 client with chunked bodies and line streaming for SSE. `j3.data.json` parses and writes JSON. TLS goes through system OpenSSL 3. | The server backend and the model downloader can be pure J3 **on Linux**. |
| `j3.net.*` is a stub on Windows and macOS today (roadmap, "Network follow-ups"). | On Windows, before J3 fills that in: talk to llama.cpp in-process (native backend), and download through `curl.exe`, which ships with Windows 10+. |
| `j3c` builds Windows exes from Linux (they run under wine), but **`j3c` does not run on a Windows host** yet (j3 plan 04, goal 3). | **Development needs a Linux host** until that lands. See decision D1 (§11). |
| `j3.thread` (pool, queue, mutex) works on Linux and has a Windows layer. `j3.instance` gives one running copy plus a request/reply channel (abstract socket on Linux, named pipe on Windows). | Background workers per agent. The CLI talks to the manager through `instance.request`. |
| `j3.term` covers TUIs and ANSI. `.j3ui` builds native desktop UI. `j3.io` has atomic writes, file locks, walk, and file watching. `j3.hash` has `sha256`. | A TUI and a desktop dashboard need no new deps. Download hashes are checked in J3. |
| J3 project rule: if J3 is missing something, **stop and write a prompt for the j3c agent**. Don't work around it. | §10 lists the J3 gaps we expect, each with a request ready to hand over. |

### Nanbeige4.2-3B (from its Hugging Face card and discussions)

- About 4B parameters in total, 3B without embeddings. A **looped transformer**: it reuses its layers to gain
  capacity. Apache-2.0.
- The card claims a 256K context. On a desktop we will use much less, limited by KV-cache memory (§5.4).
- Thinking is on by default. For code-agent work the card says to use `preserve_thinking=True`.
- Tool calls: **`tool_call_format="xml"` is the recommended format**. JSON is also supported.
- Sampling for agent and tool work: `temperature 1.0`, `top_p 0.95`, `top_k 20`.
- Community GGUFs run from about 2.5 GB (Q4_K_S) to 4.4 GB (Q8_0). Their quality varies: one repo reports
  tokenizer drift in other conversions, and some ship a llama.cpp patch. For tool use, the advice is Q6 or higher.
- **There is a known llama.cpp bug where its tool-call parser drops about 1 in 6 valid calls** for this model
  (HF discussion #17). **So JBotics parses tool calls itself** and does not use llama-server's `tool_calls` field.

---

## 3. Architecture

```
            jbotics CLI / TUI / desktop UI (.j3ui)
                          │  instance.request (local socket / named pipe)
                          ▼
┌──────────────────── jbotics manager ─────────────────────┐
│  task queue · scheduler · session store · event log       │
│                                                           │
│   ┌── agent ──┐   ┌── agent ──┐   (one j3.thread worker   │
│   │ loop      │   │ loop      │    per running agent)     │
│   │ context   │   │ context   │                           │
│   │ tools ────┼───┼── sandbox: workspace jail, git, proc  │
│   └────┬──────┘   └────┬──────┘                           │
│        └──── Backend (trait) ────┐                        │
└──────────────────────────────────┼────────────────────────┘
          ┌────────────────────────┼─────────────────────┐
          ▼                        ▼                     ▼
  ServerBackend            NativeBackend          OpenAICompatBackend
  llama-server child       libllama via C shim    any /v1 endpoint
  HTTP + SSE               in process             (optional)

  Installer: hardware probe · model registry (profiles/*.toml) · HF downloader · llama.cpp runtime fetcher
```

### Layers

Each layer only depends on the ones below it. Each file has one job and stays under 500 lines.

| Layer | Folder | Holds |
|---|---|---|
| Interface | `src/cli/`, `src/tui/`, `ui/` | Argument parsing, commands, rendering. No agent logic. |
| Manager | `src/manager/` | Task queue, scheduler, agent workers, IPC server. |
| Agent | `src/agent/` | The loop, prompt building, context packing, tool-call parsing, budgets, loop detection. |
| Tools | `src/tools/` | One file per tool, plus the sandbox they all go through. |
| Model | `src/model/` | The `Backend` trait, backends, chat templates, sampling, profiles. |
| Install | `src/install/` | Hardware probe, registry, downloader, runtime installer. |
| Base | `src/base/` | Paths, config, logging, errors, JSONL store, small helpers. |
| Native | `native/` | The C shim over libllama, its build script, and the pinned llama.cpp version. |

---

## 4. Inference backends

### 4.1 The `Backend` trait

```
trait Backend {
    fn info(): ModelInfo;                        // ctx size, vocab, special tokens, template
    fn tokenize(text): []i32;
    fn complete(req: CompletionReq, sink): Result<CompletionDone, BackendError>;
        // prompt text (already templated), sampling, optional GBNF grammar,
        // stop strings, max tokens; streams tokens to `sink`; supports cancel
    fn health(): Health;
}
```

The agent always sends **raw, already-templated prompt text** plus an optional grammar. It never sends
chat-API "messages + tools". That keeps tool-call parsing in our hands (see the llama.cpp bug above) and makes
every backend behave the same way.

### 4.2 ServerBackend (first to build, Linux)

- Starts `llama-server` from `runtimes/<tag>/` with `j3.proc`: `-m <gguf> -c <ctx> --port <free> -np <slots>
  --cache-type-k q8_0 --cache-type-v q8_0` plus profile flags. Waits on `/health`.
- Calls `/completion` with `stream: true`, reads SSE with `j3.net.http`, and passes `grammar`, `n_probs: 0`,
  `cache_prompt: true`, and `id_slot`. Prompt caching matters a lot here: each agent step adds to the same prefix.
- Uses `/tokenize` for token counting and `/apply-template` only to **check** our templates against the GGUF's
  own Jinja template in tests.
- Owns the process: restarts it on a crash, stops it when nothing uses it, logs stderr to the session.
- `OpenAICompatBackend` is a small variant pointed at any `/v1/completions` URL. It costs little and lets users
  plug in Ollama, LM Studio, vLLM, or a server on another machine.

### 4.3 NativeBackend (in-process, Phase 8)

- `native/jb_llama.c`, a shim of about 300 lines over `llama.h`: `jb_load(path, n_ctx, n_gpu_layers, ...)
  -> ptr`, `jb_tokenize`, `jb_decode_batch`, `jb_sample(ctx, sampler, ...) -> i32`, `jb_token_piece`,
  `jb_grammar_sampler`, `jb_free`. Only pointers, ints, floats, and caller-owned buffers cross the boundary.
  No structs by value and no callbacks.
- Linked as a shared library shipped beside the exe (`libjbllama.so` / `jbllama.dll` together with
  `libllama`/`ggml*`), declared with `use lib "jbllama"`.
- Why have it: no HTTP hop, it works on Windows before `j3.net` does, and it gives full control (KV-cache reuse
  per agent, cancelling mid-token).
- Inference runs on a `j3.thread` worker. Tokens go back through a `Queue`.

### 4.4 Chat templates

We don't implement Jinja. Each profile describes its template as plain pieces:

```toml
[template]
bos = "<|...|>"
system = "<|im_start|>system\n{content}<|im_end|>\n"     # placeholders: filled in from Phase 0 dump
user = "..."
assistant_open = "..."
think_open = "<think>"   # exact tags come from the GGUF metadata, not guessed
think_close = "</think>"
tool_result = "..."
```

`tests/template/` renders sample conversations both ways (ours, and llama-server `/apply-template`) and
requires them to match byte for byte for each profile. The hand-written templates are the main risk, and this
test is what covers it.

---

## 5. The agent

### 5.1 The loop

```
load task → build system prompt (rules, tools, repo map, task, verify cmd)
repeat until done / budget out:
    prompt = template(system, compacted history, latest observations)
    out    = backend.complete(prompt, grammar = TOOL_CALL_GRAMMAR, stop = profile.stops)
    call   = parse(out)                  // our XML parser; on failure: one repair retry with the error
    check  = policy.allow(call)          // sandbox + approval mode
    obs    = tools.run(call)             // truncated, with line numbers, errors made clear
    git commit if files changed          // "jb: <tool> <path>" on branch jb/<task-id>
    if call is `done`: run verify cmd → pass: finish · fail: feed output back, continue
    loop detector · budget check · compaction when context > 70%
write report (summary, diff stat, verify result, tokens, time)
```

### 5.2 Tools (few, on purpose)

| Tool | Does |
|---|---|
| `list` | Directory tree under a path, depth limited, `.gitignore` respected |
| `read` | File slice with line numbers (`path`, `start`, `count`). Large files are capped and paged. |
| `search` | Regex search, returns `path:line: text`, capped |
| `edit` | Exact `old` → `new` replace. Must match once. If not, the error shows the closest matching lines. |
| `write` | Create a file, or overwrite a small one |
| `run` | Shell command in the workspace with a timeout. Output capped (head and tail). |
| `done` | Says the task is finished, with a summary. The harness runs verify before it accepts this. |

Each tool has a one-line description and an example call in the prompt. Small models copy examples much better
than they follow schemas. The tool set per agent is configurable (a read-only "explain" agent, for example).

### 5.3 Output format and grammar

- The model's native format is XML tool calls (the profile names the exact tags). We write a **GBNF grammar** per
  profile: an optional think block, then exactly one tool call with known tool names and required arguments.
  The grammar makes "almost a tool call" output impossible.
- If a profile's thinking block would be hurt by a grammar, we use a two-phase decode instead: free thinking up to
  `think_close`, then the grammar for the call. This is chosen per profile and measured in evals.

### 5.4 Context budget (the main constraint for a 3B model)

- Default context **32K tokens** with q8_0 KV cache. `doctor` suggests the size from free RAM/VRAM. The 256K
  claim is not something a desktop can hold.
- **Repo map**: a compact tree plus top-level symbols per file, found by regex per language (no tree-sitter in
  v1), with a capped budget.
- Observations get truncated. Old tool outputs are replaced by one-line stubs ("read src/x.c 1-80, 2.1K tokens,
  dropped").
- **Compaction** at 70%: the model (or a template, if it does worse) writes a short "state so far" note: goal,
  files changed, what failed, next step. History restarts from it. The prefix stays stable so the server's
  prompt cache keeps hitting.

### 5.5 Staying on track

- **Loop detector**: the same call (tool and arguments hashed) 3 times, or 3 edits in a row that fail the same
  way, adds a nudge. If it happens again, a reset to the compacted state with a "try a different approach" note.
- **Budgets per task**: steps, tokens, wall time, and how many times `done` may fail verify. When a budget runs
  out, the task ends with a clean report, not a crash.
- **Plan note**: the first step asks for a numbered plan, which stays pinned in context. Each `done` attempt is
  compared with it.

---

## 6. Autonomy and safety

| Mode | Edits | `run` commands |
|---|---|---|
| `ask` | Ask before each | Ask before each |
| `auto-edit` (default) | Automatic | Allowlist automatic, others ask |
| `full-auto` | Automatic | Automatic in the sandbox |

- **Workspace jail**: every path is resolved and must stay under the workspace root. Symlinks that escape are
  refused. `.git/` can't be written by tools.
- **Git as the safety net**: the task runs on `jb/<task-id>` from a clean tree (or a `git worktree` so several
  agents can share a repo). Every change is a commit. Undo is `git reset`. The user's branch is never touched.
- **Commands**: run through `j3.proc` with no shell unless the profile allows `sh -c`. There is a default deny
  list (`rm -rf /`, `curl | sh`, `git push`, package publishing), and env vars are scrubbed (tokens, keys).
- **Network**: tools get no special network access. Phase 9 adds an OS-level sandbox (Linux namespaces /
  bubblewrap if present; a Windows job object).
- Everything is logged: each prompt, completion, call, and observation goes to `sessions/<id>.jsonl`, which can be
  replayed in the TUI.

---

## 7. Installing models and runtimes

### 7.1 `jbotics doctor`

It reports CPU (cores, AVX2/AVX-512/NEON), RAM, GPUs and VRAM (from `nvidia-smi`, `vulkaninfo --summary`, or
`/sys/class/drm` when present), free disk space, and which runtimes and models are installed. From that it
recommends a backend (cuda / vulkan / cpu), a quant, a context size, and `-ngl`.

### 7.2 Runtime installer

- `jbotics runtime install [--backend cuda|vulkan|cpu] [--tag bNNNN]` downloads a **pinned** llama.cpp release
  zip for the OS and backend, checks it, and unpacks it to `runtimes/<tag>-<backend>/`. `runtime list|use|rm`.
- `--from-source` runs cmake against a checkout (for the Nanbeige-specific patch if we need it; Phase 0 decides).
- The pinned tag lives in `native/LLAMA_CPP_VERSION`. Upgrades are deliberate and gated on evals.

### 7.3 Model registry and profiles

`profiles/<id>.toml` is one file per model:

```toml
id = "nanbeige4.2-3b"
name = "Nanbeige4.2 3B"
license = "apache-2.0"
arch_note = "looped transformer; needs llama.cpp >= <tag>"

[source]                 # chosen in Phase 0 (tokenizer-faithful conversion)
repo = "<hf-org>/Nanbeige4.2-3B-GGUF"
revision = "<commit sha>"
[source.files]
Q4_K_M = { file = "...", sha256 = "...", bytes = 0 }
Q6_K   = { file = "...", sha256 = "...", bytes = 0 }
Q8_0   = { file = "...", sha256 = "...", bytes = 0 }

[defaults]
quant = "Q6_K"
ctx = 32768
[sampling.agent]
temperature = 1.0
top_p = 0.95
top_k = 20

[template]   # §4.4
[tools]      # call format (xml), tags, grammar file
```

- `jbotics models list|search|pull|rm|info`. Profiles are bundled with `@embedDir`. User profiles in the data
  dir override them.
- `models pull <id>[:quant]` uses HF's resolve URL with a pinned revision, keeps `.part` files, resumes with
  `Range`, checks sha256 with `j3.hash`, and moves the file into place with an atomic rename.
- `models add <path.gguf>` takes any local GGUF. It reads the GGUF header (metadata, chat template) in J3 to write
  a starter profile.

### 7.4 Where files live

| | Linux | Windows |
|---|---|---|
| Config | `~/.config/jbotics/config.toml` | `%APPDATA%\jbotics\config.toml` |
| Data (models, runtimes, sessions) | `~/.local/share/jbotics/` | `%LOCALAPPDATA%\jbotics\` |

`JBOTICS_HOME` overrides both. Models are big, so `models_dir` can be set on its own.

---

## 8. Manager and many agents

- `jbotics serve` is the manager. It claims a single instance (`j3.instance`). CLI commands that need it start it
  if it isn't running.
- **Tasks** (`tasks/<id>.toml` plus a JSONL log) have states `queued → running → verifying → done | failed |
  stopped`. A task holds: goal, workspace, profile, verify command, budgets, and autonomy mode.
- **Scheduling**: one llama-server per model, with `-np N` slots. Agents get a slot. The rest wait in the queue.
  Free RAM/VRAM caps how many model servers run at once.
- **Commands**: `jbotics run "<goal>" [--dir . --verify "make test" --model x]` (runs in the foreground and shows
  the stream), `task add|list|show|stop|logs|diff|merge`.
- **Roles (Phase 10)**: a profile can mark an agent as planner, worker, or reviewer, so one small model can run
  plan → do → review as three focused contexts instead of one cluttered one.

---

## 9. Interfaces

1. **CLI** (Phase 1 on): plain output that pipes well. `--json` for scripts.
2. **TUI** (Phase 9): `j3.term`. Task list, live token stream, tool calls folded, diff view, approve/deny keys.
3. **Desktop dashboard** (Phase 9+): `.j3ui`. Models (pull progress, disk), runtimes, tasks, session replay, eval
   charts. Same IPC as the TUI.

---

## 10. J3 gaps to raise (don't work around them)

Each gets a request written for the j3c agent when we reach it.

| # | Gap | Needed by | Interim |
|---|---|---|---|
| G1 | `j3c` running on a Windows host | Dev on this PC | Develop on Linux (D1) |
| G2 | `j3.net.tcp/dns/http` on Windows | ServerBackend on Windows, downloads | NativeBackend + `curl.exe` through `j3.proc` |
| G3 | TLS on Windows (SChannel, or bundled OpenSSL) | Downloads on Windows | `curl.exe` |
| G4 | Confirm the FFI rules: struct by value, callbacks, `[link]` for C++ libs (libstdc++), rpath `$ORIGIN` | NativeBackend | The shim makes the first two moot. Linking is checked in the Phase 0 spike. |
| G5 | Reading a TOML file at runtime (`j3.toml` is read by j3c, but is there a stdlib parser?) | Config, profiles | If none exists: ask for `j3.data.toml`. Fallback: JSON config. |
| G6 | Regex in the stdlib | `search` tool, repo map | Ask for `j3.text.regex`. Fallback: run `rg`/`grep` through `j3.proc`. |
| G7 | Process groups / kill a whole tree, plus a resource limit | `run` tool timeouts | `timeout` on Linux, a job object request for Windows |

---

## 11. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Where to build.** J3 can't build on Windows yet. | Use a Linux box (or VM) for dev, test Windows exes under wine, and push j3 plan 04's "j3c on a Windows host" in parallel. (WSL was declined before. Leaving it out.) |
| D2 | Hardware for the first target | Tell us the GPU/RAM. That decides the CUDA vs Vulkan vs CPU default and the quant. |
| D3 | License | MIT OR Apache-2.0, the same as J3. |
| D4 | Which GGUF conversion of Nanbeige4.2-3B | Phase 0 picks one by testing tokenizer fidelity. Or we convert it ourselves with llama.cpp's `convert_hf_to_gguf.py` from the official weights. |

---

## 12. Phases

Each phase ends with a check that someone can run. Nothing moves on until that check passes.

| Phase | Builds | Exit check |
|---|---|---|
| **0. Spikes** | (a) llama.cpp runs a Nanbeige GGUF on your hardware. Record tok/s for prompt and generation at Q4/Q6/Q8. (b) Dump `tokenizer.chat_template` and the special tokens from the GGUF and write the exact think and tool tags. (c) Compare GGUF conversions for tokenizer fidelity; pick one (D4). (d) Hand-feed 10 tool-use prompts; record call validity with our parser vs llama.cpp's. (e) J3 spike: call one shim function (`llama_print_system_info`) through `use lib`, and stream `/completion` SSE from llama-server. | `docs/spikes.md` with the numbers, the template, the chosen GGUF, and a go/no-go per item |
| **1. Skeleton** | CLI parsing, `base/` (paths, config, log, errors, JSONL store), `jbotics version`, `jbotics doctor` (hardware probe), test runner script, CI on Linux | `tests/run.sh` passes. `doctor` prints real hardware. |
| **2. ServerBackend** | Start/stop/health for llama-server, streamed completion, cancel, tokenize, profile loading, templates for Nanbeige + template-match test | `jbotics chat --model nanbeige4.2-3b` streams. Template tests match `/apply-template`. |
| **3. Installer** | Runtime install (pinned, checked), model pull (resume, sha256, atomic), `models list/rm/add`, GGUF header reader | From an empty machine, `runtime install && models pull nanbeige4.2-3b` gives a working `chat` |
| **4. Agent core** | Loop, the 7 tools, sandbox jail, XML parser + repair retry, grammar, repo map, truncation, `jbotics run` | The agent fixes a seeded failing test in a fixture repo, end to end |
| **5. Autonomy** | Git branch/worktree per task, per-step commits, verify gate, budgets, loop detector, compaction, approval modes, reports | Unattended `full-auto` run on 5 fixture tasks: no writes outside the jail, every run ends with a report |
| **6. Evals** | `evals/tasks/*` (fixture repo + goal + check script), `jbotics eval` with pass rate, steps, tokens, time; a mock backend for deterministic loop tests | Baseline numbers for Nanbeige at Q4/Q6/Q8 committed to `evals/results/`. Then every loop change shows its delta. |
| **7. Manager** | `serve`, IPC, queue, slots, several agents at once, `task *` commands | 3 tasks in parallel on one server, each on its own worktree |
| **8. NativeBackend + Windows** | C shim, in-process inference, Windows build (wine first, then real hardware), `curl.exe` downloads until G2/G3 land | `jbotics.exe run` completes an eval task on Windows 11 |
| **9. UI + sandbox** | TUI, `.j3ui` dashboard, OS sandbox | Watch and approve a live task in the TUI. Desktop shows models and tasks. |
| **10. More models + roles** | Profiles for other open coder models (each with template tests + eval baseline), planner/worker/reviewer roles | 3+ profiles with eval numbers. Roles beat a single agent on evals, or get dropped. |

### Phase 6 note: what counts as an eval task

About 30 tasks to start, in a few languages (C, Python, JS, J3), sized for a 3B model:

- Fix a failing unit test (one-file bug).
- Add a small function plus a test that a check script runs.
- Rename across 3–5 files.
- Read a stack trace and fix the cause.
- "No change needed": the agent must not damage a passing repo.

Each task: `repo/` (fixture), `task.toml` (goal, verify, budget), and `check.sh` (hidden from the agent;
decides pass or fail). The same seed and settings give the same run against the mock backend.

---

## 13. Repo layout (target)

```
jbotics/
  j3.toml
  src/
    main.j3                 entry: parse args, dispatch
    cli/                    one file per command group (run, task, models, runtime, doctor, serve, chat, eval)
    base/                   paths, config, log, errors, jsonl, fmt helpers
    install/                hardware, registry, download, runtime, gguf (header reader)
    model/                  backend (trait), server, native, openai, template, sampling, profile
    agent/                  loop, prompt, context, repomap, parse, grammar, budget, loopdetect, compact, report
    tools/                  sandbox, list, read, search, edit, write, run, done
    manager/                serve, queue, scheduler, worker, ipc, task
    tui/                    (phase 9)
  ui/                       .j3ui dashboard (phase 9)
  native/                   jb_llama.c, jb_llama.h, build.sh, LLAMA_CPP_VERSION
  profiles/                 <model-id>.toml, <model-id>.gbnf
  evals/                    tasks/, results/
  tests/                    run.sh, unit programs, fixtures/, mock backend
  docs/                     PLAN.md, spikes.md, profiles.md, architecture notes
```

---

## 14. Engineering rules

- Files stay under 500 lines. Split by concern before getting close.
- Every external thing sits behind an interface: backend, downloader, clock, process runner. That way tests run
  with no model, no network, and no git remote.
- No dependencies beyond J3's stdlib, llama.cpp, and tools already on the system (`git`, optionally `rg`/`curl`).
- Each phase lands with tests. Agent-behaviour changes land with eval numbers.
- Logs and sessions never leave the machine. No telemetry.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| A 3B model is too weak for real autonomy | Harness-heavy design (§5), eval gating, task sizing guidance, and an easy model switch through profiles |
| Hand-written templates drift from the model's real ones | Byte-for-byte template test against `/apply-template` (§4.4) |
| Looped-transformer support in llama.cpp is new or patched | Pin the llama.cpp tag. Phase 0 checks the output against the reference (transformers) on a few prompts. |
| Community GGUF tokenizer bugs | Phase 0 fidelity check, a pinned revision + sha256, or our own conversion |
| J3 platform gaps (Windows build host, Windows net) | Linux first. The NativeBackend + `curl.exe` route. Gap requests filed early (§10). |
| Agent damages a user repo | Branch/worktree isolation, path jail, command deny list, no `git push` |
