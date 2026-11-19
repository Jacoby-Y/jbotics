# JBotics

Run and manage autonomous coding agents on **local models**. Written in [J3](https://github.com/Jacoby-Y/j3),
inference through [llama.cpp](https://github.com/ggml-org/llama.cpp).

First target: **Nanbeige4.2-3B** as an unattended coding agent on a desktop machine. Other models plug in
through profiles.

> **Status:** planning. See [docs/PLAN.md](docs/PLAN.md) for the design, phases, and open decisions.

## Planned shape

```sh
jbotics doctor                          # hardware, suggested backend / quant / context
jbotics runtime install                 # pinned llama.cpp build for this machine
jbotics models pull nanbeige4.2-3b      # resumable, hash-checked download
jbotics run "make the failing test pass" --verify "make test"
```

Each task runs on its own git branch, commits each step, and ends with a report and a diff for you to review.

## Build

Needs `j3c` (Linux host for now; see PLAN §2 and decision D1).

```sh
j3c check
j3c run
```
