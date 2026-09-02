<div align="center">

<h1>The Prompt</h1>

**The instruction this project runs on.**

No framework, no scaffolding, no per-module briefs written by hand.
It is handed to Claude Code once, and the model does the rest — including deciding what "the rest" is.

</div>

<br>

> [!NOTE]
> Copy the raw file and swap the domain. The structure works for anything that can be screenshotted,
> measured, or otherwise checked by the machine that produced it — the game is only the example.

<br>

---

<br>

# Goal
Build a Cities: Skylines II–class city builder in Three.js (latest release) + Vite, plain ES modules, from this empty folder. The bar is AAA: photographic PBR materials, physically plausible sun/sky/shadows, atmospheric depth, a living city at night, believable roads and traffic. Never programmer art.

# How to work
1. Architecture first. Before any feature code, write ARCHITECTURE.md: one folder per subsystem (terrain, environment, roads, zoning, buildings, props, traffic, effects, simulation, tools, ui, audio, demo city), a shared world data model, the public API each module must expose, the events it emits, units (metres, +Y up), determinism (seeded RNG only), a performance budget (≥50 fps at 1080p, ≤1500 draw calls) and an asset policy (CC0 only: Poly Haven, ambientCG, or procedural). Isolate module failures so one broken module never takes the game down.
2. Build the verification loop before the game. A headless-Chrome screenshot tool that loads the app, waits until ready, sets a camera preset and time of day, and writes PNG + a JSON log (console errors, fps, draw calls). Every module also ships a "showcase" mode that stages a representative scene of just that module. No agent may claim anything it hasn't screenshotted and looked at.
3. Fan out. Use multi-agent orchestration ("ultracode"). One builder agent per module, each owning only its folder. Run in waves ordered by dependency: (1) terrain, sky/weather, roads, simulation, UI, audio, effects; (2) zoning, buildings, props, traffic, build tools; (3) demo city. Between waves, one integrator agent (the only one allowed to touch core) applies builders' core-change requests and fixes the seams.
4. Gauntlet every module. After each builder round, a separate critic agent (a brutal AAA art director who writes no code) takes its own screenshots at several times of day and zoom levels, checks the API contract, console errors and perf, and scores 0–10 against real Cities: Skylines II reference screenshots: 10 = indistinguishable, 8.5 = AAA with nits, 7 = good indie, 5 = programmer art. Pass = ≥8.5 with zero errors. Below that, the builder gets the ranked issue list and goes again, up to 4 rounds.
5. Final gate. A whole-game critic scores the demo city. Then blind judges get pairs of screenshots labelled only A and B (ours vs. Cities: Skylines II, order shuffled) and say which looks better and why.
6. /loop until every critic passes. Persist scores and open issues to docs/STATUS.json so each iteration resumes from the weakest module, not from scratch.

# Rules
- Never inflate scores. Report real numbers, failed rounds and what is still missing.
- Never edit another module's folder. Core changes go through the integrator.
- Keep the dev server running and the app loadable at all times; other agents are screenshotting it.
- Do not ask me questions. Make routine decisions yourself, state assumptions, keep going.

Start now.

<br>

---

<br>

## Why it is shaped this way

Each numbered step exists because leaving it out breaks something specific.

| Step | What it prevents |
|:--|:--|
| **Architecture first** | A dozen agents editing the same files. The contract is what makes parallelism safe — it is ordinary interface-first design, and it works better for agents than it does for people. |
| **Tooling before features** | Hallucinated success. Without a way to look at the output, a model will cheerfully report that a broken shader "renders beautifully". |
| **Fan out in dependency waves** | Agents blocking on each other, or building against an API that does not exist yet. |
| **A separate critic** | Grade inflation. A model reviewing its own work is far too generous. The critic writes no code, so it has nothing to defend. |
| **An anchored 0–10 scale** | "Looks good" as an acceptance criterion. Written anchors — *8.5 = AAA with nits, 5 = programmer art* — make the score mean the same thing in every round. |
| **A blind final gate** | Judging your own child. Labelled *A* and *B* with the order shuffled, the judge cannot flatter the home team. |
| **Persisted state** | Starting over. Every iteration picks up at the weakest module instead of re-deriving what is already done. |

If you only take two things from this: **make a separate critic**, and **make the agent look at its own
output before it is allowed to say "done"**. Those two alone carry most of the weight.

## How it actually went

Honest, because the prompt itself says never to inflate anything:

- The first run produced terrain, sky, roads, simulation, HUD and audio, then hit a usage limit.
- Six runs later the game was playable. About 20 million output tokens across the agents.
- **No module ever cleared the 8.5 bar**, and three rounds of blind judging were lost 0–4 each time.
  The gap narrowed from 3.4 points to 2.5. One judge said our frame "wins atmosphere and composition
  outright" before killing it on material physics.
- A first-session critic scores the new-player experience 5.5 out of 10 and does not pass it.

Everything the critics wrote is in [`docs/critique/`](docs/critique/), unedited, including the rounds
where scores went down.

<br>

<div align="center">

[← Back to the project](README.md)

</div>
