# JBotics

A J3 program that installs, runs, and manages autonomous coding agents on local models (llama.cpp).
**`docs/PLAN.md` is the design and the source of truth for scope and phases.** Read it before changing structure.

## Learning J3

Learn J3 from `j3c` only: `j3c guide`, `j3c doc`, `j3c doc search <word>`, `j3c doc recipes <name>`
(`http`, `threads`, `tui`). Don't read the j3c compiler or stdlib source to work out the language.

**If J3 or j3c is missing something a task needs, stop.** Don't work around it, fake it, or patch the
toolchain. Say what is missing and offer a full prompt (in one code block) to hand to the j3c agent. Known and
expected gaps are tracked in PLAN §10.

## Rules

- Every file stays under 500 lines and has one job. Split before getting close.
- Layers depend only downward: `cli/tui/ui → manager → agent → tools, model → install → base` (PLAN §3).
- External things (model backend, downloads, processes, clock) sit behind interfaces so tests run with no model
  and no network.
- No new dependencies beyond the J3 stdlib, llama.cpp, and system `git` (optionally `rg`, `curl`).
- Tool calls are parsed by JBotics, never by llama-server's `tool_calls` (PLAN §2: known parser bug).
- Agent-behaviour changes (prompts, loop, parsing, compaction) need eval numbers (PLAN §12, phase 6).
- Never commit model weights, runtimes, or sessions (see `.gitignore`).
- Wrap anything long-running (llama-server, agent runs, evals) in `timeout`.
