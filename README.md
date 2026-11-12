# pi-github-copilot-auto

Adds **`github-copilot-auto/auto`** models and opt-in **Copilot Fusion** models
(`github-copilot-fusion/standard`, `/high`, `/max`) to [pi](https://github.com/earendil-works/pi).
Auto follows GitHub Copilot's own server‑side auto model selection — the single‑call
**AutoV2 router** (`POST /auto`). Fusion Standard uses the same router with the
observed Fusion routing flags; Fusion High and Max use server-authored plans
(`POST /model/fusion`).

This started as a port of
[opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model)
to pi's extension/provider API, and has since been evolved to the newer `POST /auto`
endpoint with routing‑tier support.

## How it works

GitHub Copilot "auto" now routes each turn with a single call on the Copilot API host:

- `POST /auto` — takes the prompt (plus an optional routing `tier`) and, in one
  round‑trip, **both** picks the model for that prompt **and** mints the
  `Copilot-Session-Token` the chat request bills against. The response embeds the
  full metadata of the selected model plus per‑dimension `hydra_scores`
  (`reasoning`, `code_gen`, `debugging`, `tool_use`).

Because the router returns the selected model's metadata directly, the routable
pool includes newer models that never appeared in the legacy
`POST /models/session` pool (e.g. `gpt-5.6-*`, `claude-opus-5`, `claude-sonnet-5`).

This package routes through `/auto`, then delegates the request to the selected
model through pi's provider stream. Models pi doesn't already know about are
synthesized from the `/auto` response metadata (endpoint family inferred from the
vendor/id) so brand‑new models remain routable without a package update.

> **Note:** `/auto` requires `X-GitHub-Api-Version: 2026-08-01`. The older
> `2026-06-01` that `/models/session` accepted is rejected with
> `invalid apiVersion`.

## Routing tiers

`POST /auto` accepts a routing **tier** (VS Code's `autoModeTiers`) that biases
which models the router may pick from:

| Tier | Intent |
|------|--------|
| `efficiency` | Cheapest / lightest models |
| `balance` | Default — sensible cost/quality trade‑off |
| `intelligence` | Prefer the most capable models |

Legacy config/session tier values are normalized before the `/auto` request:
`eco` → `efficiency`, `balanced` → `balance`, `max` → `intelligence`. They are
not registered as picker entries.

You pick a tier by **selecting one of the registered models**:

| Model id | Tier used |
|----------|-----------|
| `github-copilot-auto/auto` | The configured default (`balance` unless overridden) |
| `github-copilot-auto/auto-efficiency` | `efficiency` |
| `github-copilot-auto/auto-balance` | `balance` |
| `github-copilot-auto/auto-intelligence` | `intelligence` |

Switching between them mid‑conversation re‑routes on the next turn. You can also
change the default that the bare `auto` model uses via the `tier` config option
(see below). VS Code's internal `fast` tier is not offered as a picker entry but
can be forced through the `tier` config value.

## Copilot Fusion Standard (opt-in)

Select **`github-copilot-fusion/standard`** to opt into Fusion Standard without
changing the existing Auto provider. It shares pi's GitHub Copilot login and pi
continues to own the agent loop, tools, permissions and transcript. The provider
sends `POST /auto` with `tier: "balance"`, `fusion: true`, and the observed
`hydra_rl_multi_turn: {}` / `multi_turn` fields, then delegates the selected model
through pi's native model stream with the returned session token.

> **Experimental:** the multi-turn routing reproduces behaviour inferred from
> native Copilot CLI traces (see *Multi-turn routing*), not a published
> contract. Model selection, request count, usage and billing may still differ
> from the native Copilot clients.

Fusion Standard is distinct from classic `github-copilot-auto/auto-balance`.
Before advertising Standard, the extension checks authenticated `GET /meta`
at startup (including `--list-models` and resume). It requires an `auto.tiers`
entry with `id: "balance"`, `type: "auto"`, `status.enabled: true`, and no
explicit `tier_picker_enabled: false`. It also requires a picker-visible tier of
`type: "fusion"`: `balance` alone can describe classic Auto. As in the pinned
VS Code client, the Fusion-type tier need not itself be enabled, and a missing
picker-visibility flag means visible. A catalog without any visible Fusion tier
is indistinguishable from classic Auto using these signals, so Standard is hidden.
Missing credentials, a disabled/hidden Standard tier, invalid metadata, HTTP
errors or a metadata request timeout (5 seconds) also hide Fusion; classic Auto
remains registered. This checks metadata availability, not full native equivalence.

After logging in or changing accounts/entitlements, run `/reload` or restart pi
to refresh availability. If metadata cannot confirm Standard during resume,
Fusion is not registered; there is no silent fallback to classic Auto in this
provider. `/auto` and chat still use API version `2026-08-01`; only `/meta` uses
`2026-09-21`.

### Multi-turn routing

Routing tokens are memory-only; the saved session keeps the
`github-copilot-fusion/standard` selection. The router's anchor response carries
`multi_turn_mode: "model_cards"` and controls (`initial_skip`,
`backoff_coefficient`, `max_skip`, `anchor_skip`, `context_window`, a
per-capability `sigma`, `escalate_threshold`). With valid controls, four finite
`hydra_scores` and identified real user messages (see below), each new user turn
follows the cadence observed in native Copilot CLI 1.0.109 traces:

- **Anchor** (first turn, and after restart, tree navigation or expiry):
  `multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 }`. The skip
  window starts at `initial_skip`; the first check is `anchor_skip + 1` turns later.
- **Skipped turns:** inside the skip window there is no `/auto` call; the chat
  reuses the anchor's model and session token.
- **Drift check** (`routing_intent: "drift_check"`): sends `turns_since_anchor`,
  `current_skip_window` and `anchor_cap_vector` (the anchor's `hydra_scores`). The
  prompt is the last `context_window + 1` real user messages, each truncated to
  1,022 characters, joined by a blank line.
  - **Escalate** when at least `escalate_threshold` capabilities rose above the
    anchor's by more than their `sigma`: the drift response becomes the new anchor
    (its model *and* token, even if the model is unchanged). The cadence resets,
    with a confirming check on the next turn; later drift prompts start from
    that confirming turn.
  - **Otherwise stay** on the anchor, even when the router suggested a different
    (e.g. cheaper) model. The next check comes after `current_skip_window` skipped
    turns, with the window multiplied by `backoff_coefficient` up to `max_skip`
    (observed natively: checks at turns 2, 5 and 10).
  - **Drift check fails** → continue on the unexpired anchor and check again on
    the next turn.
- **Compaction** keeps the anchor and forces a drift check on the next turn.
  The drift prompt still includes user messages that compaction removed from
  pi's context (kept in a small in-memory log), as natively.
- Tool continuations and text-less (e.g. image-only) turns reuse the current route.
- Without valid controls or identities, every new user turn gets a fresh
  `anchor` route.
- **Summaries:** pi's compaction and branch summarizers call the model under
  their own throwaway session ids. Those requests get their own one-off `anchor`
  route (router prompt capped at the last 16,000 characters) without retaining
  state or updating the footer. This differs from the native client, whose
  compaction made no `/auto` call and used the anchor's token. A summarizer that
  reuses the session id reuses the current route without counting as a user turn.
- A route near expiry is never used: the next request re-anchors on the current
  message (which may drop an escalated route), and fails closed if that fails.
  Native behaviour for an actually expired route was not observed.

The footer shows what happened on each turn; a toast appears only when the
route changes (anchor or escalation):

| Footer | Meaning |
|--------|---------|
| `fusion:standard → gpt-6-luna (anchor)` | New anchor route |
| `fusion:standard → gpt-6-luna (kept, next check in 2 turns)` | Skipped turn, no `/auto` call |
| `fusion:standard → gpt-6-luna (checked, kept; next check in 5 turns)` | Drift check kept the route |
| `fusion:standard → gpt-6.1-sol (escalated)` | Drift check adopted a stronger route |
| `fusion:standard → gpt-6-luna (check failed, kept)` | Drift check failed; route kept, retried next turn |
| `fusion:standard → gpt-6-luna (anchor each turn)` | No multi-turn controls offered |

Only *real* typed user messages define turns and drift-check context: pi maps
compaction/branch summaries, `!` bash output and extension messages to
`role: "user"`, so the extension identifies real input (timestamp and text)
through pi's `context` event. This also applies to classic Auto's router prompt.

Inferred, not published: the rules above were derived from traced native
sessions (skip windows 2/4/8, 16 sent on a forced check; escalation with 1 vs 2
capabilities above `sigma`; no switch-down; compaction; a 6-minute idle pause that
did not force a check). Behaviour outside those observations (e.g. longer idle
periods, `max_skip` saturation, or a stronger model suggested with fewer than
`escalate_threshold` rising capabilities) may differ. Control values never
observed (non-zero `anchor_skip`, a fractional `backoff_coefficient`) disable
the cadence: such routes anchor every turn. A non-empty `hydra_rl_multi_turn`
object in a router response (never observed) also makes the extension anchor
every turn; it is never echoed back. Not reproduced: an extra `gpt-5.4-nano`
request the native client sent without a route token on later turns, which is
not part of routing. Native traces used the Copilot CLI's client
identity; this extension uses pi's existing `vscode-chat` identity.

## Copilot Fusion High and Max (experimental, opt-in)

Select **`github-copilot-fusion/high`** or **`github-copilot-fusion/max`**. They are
offered only when `GET /meta` reports the `hydrafusion` (High) or
`hydrafusion-max` (Max) tier as enabled and picker-visible.

For each new real user turn the extension requests a **plan**:
`POST /model/fusion` with `{ prompt, fusion_mode: "hydrafusion" | "hydrafusion-max",
plan_version: "2", previous_turn: { model_id, reasoning_effort? } }` (API
`2026-08-01`). The server answers with a pattern (`solo`, `cascade`,
`critique`), steps (`role`, `model_id`, optional `reasoning_effort`) and a
session token. The extension then:

- runs the step's model through pi's native stream with the **plan's session
  token**, setting the step's `reasoning_effort` exactly on the request
  (`reasoning.effort` for Responses; adaptive `thinking` with summarized display
  plus `output_config.effort` for Anthropic, as observed natively; for Chat
  Completions an OpenAI-style `reasoning_effort` is assumed, not observed). Steps
  without an effort run at `medium`, as observed natively;
- reuses the plan for that turn's tool continuations and text-less turns, and
  sends the last completed step as `previous_turn` with the next plan request;
- accepts only observed plan shapes (`solo` with one `generation` step;
  `cascade`/`critique` starting with a `draft` step) and fails closed on
  anything else, or on invalid or expiring plans (no fallback to another model).

**Multi-step plans are only partly supported.** `solo` plans run as planned.
`cascade` and `critique` plans list further steps (e.g. `escalation`/`repair`,
`critic`/`revision`) that the native client executes itself; this extension
does **not** execute them. It runs only the first (`draft`) step and says so in
the footer and log (e.g. `fusion:high → gpt-6.1-sol (cascade, draft only)`). The
draft model can be weaker than what a `solo` plan would have picked, and how
GitHub bills a draft-only turn has not been verified. In a handful of sampled
prompts, Max mostly returned `solo` plans and High returned multi-step plans for
several coding/debugging prompts.

**Cost:** plans can select very expensive configurations (e.g. Max picked
`claude-opus-5.5` at `max` effort; one such native turn reported about 17.5 AIU
and 15 premium-request units). Summaries never run at a plan's effort: pi's
compaction/branch summaries use a one-off Fusion Standard route when Standard is
available, otherwise the current (or a one-off) plan's first step at `medium`.

Plan shapes and request details were derived from observed traffic of the
native client and direct plan requests; they are not a published contract.

## Install (pi package)

### 1) Install the package from GitHub

```bash
pi install git:github.com/jgrumboe/pi-github-copilot-auto
```

(Optional, project-local instead of global settings)

```bash
pi install -l git:github.com/jgrumboe/pi-github-copilot-auto
```

### 2) Reload package resources

Inside pi:

```text
/reload
```

(If pi was not running yet, just start `pi`.)

### 3) Log in to GitHub Copilot once

Inside pi:

```text
/login
```

Then choose **GitHub Copilot**.

The plugin reuses the existing credentials from `~/.pi/agent/auth.json`
(with automatic token refresh). No separate auth flow is required.

### 4) Select and use Auto

Inside pi:

```text
/model
```

Pick one of:

- **`github-copilot-auto/auto`** — default tier (`balance`)
- **`github-copilot-auto/auto-efficiency`** — cheapest models
- **`github-copilot-auto/auto-balance`** — balanced routing
- **`github-copilot-auto/auto-intelligence`** — most capable models
- **`github-copilot-fusion/standard`** — opt-in Copilot Fusion Standard (only when `/meta` confirms availability; run `/reload` after login)
- **`github-copilot-fusion/high`**, **`github-copilot-fusion/max`** — opt-in Copilot Fusion High/Max (experimental; multi-step plans run draft only)

Or run from shell:

```bash
pi --provider github-copilot-auto --model auto-intelligence
# Or opt into Fusion Standard / High / Max:
pi --provider github-copilot-fusion --model standard
pi --provider github-copilot-fusion --model high
```

### 5) Verify package install (optional)

```bash
pi list
```


## Usage

The routing decision for each conversation is shown as a transient toast
(`Auto (intelligence) → claude-sonnet-5`) and in the footer status (`auto:intelligence → claude-sonnet-5`).

### Classic Auto routing behaviour

- **Turn 0** of a conversation calls `POST /auto` and picks a model for the tier.
- **Turns 1+** reuse that pick and its session token within the running process
  (KV‑cache stability). Tokens normally last 24h; near expiry, the next request
  obtains a new routing decision and token.
- **Resume after quitting / reload:** the saved model stays `github-copilot-auto`
  with the selected `auto-*` entry. Routing tokens are memory-only, so the next
  prompt calls `/auto` again and may select a different concrete model.
- **Changing tier** (selecting a different `auto-*` model) re‑routes next turn.
- If routing fails or its token is invalid, the request fails rather than silently
  becoming a direct-model request. Upstream errors are returned to pi; the plugin
  does not try arbitrary catalog models using the selected model's Auto token.
- **After compaction**, the compacted conversation's routing cache is invalidated
  and re‑evaluated next turn.

### Existing sessions affected by the resume bug

Older versions saved assistant responses under the concrete `github-copilot`
model. Pi could then restore that model on resume, bypassing Auto routing and its
session-token header. After loading this version, select your desired
`github-copilot-auto/auto-*` entry again and send a prompt. Newly saved responses
retain that Auto identity, including on errors and tool turns. Old session files
are not rewritten, and explicit switches to a direct model are not overridden.

### GitHub Auto billing attribution

The request contract follows VS Code's
[AutoV2Fetcher](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/node/autoV2Fetcher.ts)
and [AutoChatEndpoint](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/node/autoChatEndpoint.ts):

- `/auto` returns a concrete model and an Auto session token.
- Chat requests use that **concrete model ID**, not `auto`, and carry the returned
  **`Copilot-Session-Token`** to the same Copilot API host.
- The same Copilot client identity/session headers are applied to routing and
  chat, including for models missing from pi-ai's catalog.
- Current VS Code tier names are sent on the wire (`efficiency`, `balance`,
  `intelligence`); retired names are only normalized for old config/session
  values.

Client identity headers alone do **not** establish Auto billing. The session token
is the Auto-specific signal; GitHub decides eligibility, discounts, and the
reported bucket. Local tests verify the outgoing request contract, not GitHub's
billing ledger. Check GitHub's usage report after a completed test request to
confirm its **Auto** attribution. Local pi token/cost estimates are not an
independent confirmation of that bucket or of the server-applied discount.

## Models in the auto pool

The pool the router may pick from depends on your Copilot plan and org policy, and
now includes newer models surfaced by `POST /auto`. Recent examples observed:

| Model | Provider |
|-------|----------|
| GPT-5.3-Codex | OpenAI |
| GPT-5.4 / GPT-5.4 mini | OpenAI |
| GPT-5.6 (luna/sol/terra) | OpenAI |
| Claude Haiku 4.5 | Anthropic |
| Claude Sonnet 4.6 / Sonnet 5 | Anthropic |
| Claude Opus 5 | Anthropic |

> Source: [Supported AI models in GitHub Copilot — Auto model selection](https://docs.github.com/en/copilot/reference/ai-models/supported-models#supported-ai-models-in-auto-model-selection)  
> Model availability is subject to change and varies by plan/policy.

## Optional configuration

Create `~/.pi/agent/github-copilot-auto.json` (all fields optional):

```jsonc
{
  // The auto picker entry advertises these limits to pi's context manager.
  // Keep contextWindow conservative if your pool mixes 200K and 1M models.
  "contextWindow": 200000,
  "maxTokens": 64000,

  // Default routing tier for the bare `auto` model:
  // "efficiency" | "balance" | "intelligence".
  // Legacy values "eco" | "balanced" | "max" are normalized before routing.
  // ("fast" is VS Code's internal inline-chat tier; usable but not recommended.)
  "tier": "balance",

  // Write routing decisions to a log file (see below).
  "debug": false
}
```

| Option | Type | Description |
|--------|------|-------------|
| `contextWindow` | number | Context window advertised for the `auto` entries (default 200000). |
| `maxTokens` | number | Max output tokens advertised for the `auto` entries (default 64000). |
| `tier` | string | Default tier for the bare `auto` model (default `balance`; legacy `balanced` accepted). |
| `debug` | boolean | Enable the debug log. |

## Debugging

With `"debug": true`, decisions are appended to:

- macOS/Linux: `~/.local/state/github-copilot-auto/plugin.log`
- Windows: `%LOCALAPPDATA%\github-copilot-auto\plugin.log`

```sh
tail -f ~/.local/state/github-copilot-auto/plugin.log
```

A new `delegate: model=… api=… autoSessionToken=present` entry confirms that
this version prepared an Auto-authenticated chat request. It does not log the
session token and does not prove that GitHub accepted or billed the request.
Routing tokens and access tokens are not stored in assistant message metadata.

## Development checks

```sh
npm ci --ignore-scripts
npm test              # pi-ai 0.74 legacy API
npm run test:current  # pi-ai 0.85 compatibility API, as loaded by current Pi
npm run typecheck
```

Tests use fake credentials and intercepted HTTP requests (no live Copilot calls).
They cover real Pi session-file save/resume, Auto tier persistence, Fusion
save → extension restart → resume → fresh route/token (including Responses),
fail-closed `/meta` entitlement discovery, the Fusion multi-turn cadence
(skip windows, `max_skip`, escalation vs. sticky routes, drift-prompt window and
truncation, failures, forced checks after compaction, expiry, concurrency,
classic↔Fusion switching), Fusion High/Max plans (discovery, solo execution
with the plan token, exact step effort per transport, `previous_turn`, tool
continuations, draft-only multi-step plans, invalid plans, summarizers),
real-user-turn identity and summarizer requests, signed history replay, token renewal/isolation, and HTTP headers
across all three transports.

## How it maps to pi

| opencode hook | pi equivalent used here |
|---------------|--------------------------|
| `provider.models` (inject `auto`) | `pi.registerProvider("github-copilot-auto", { models:[auto, auto-efficiency, auto-balance, auto-intelligence] })` |
| `chat.message` (capture prompt) | last user message read from `Context.messages` in `streamSimple` |
| `chat.params` (override model id) | `streamSimple` routes via `POST /auto` and delegates to the selected model's native stream |
| `chat.headers` (session token) | Case-insensitive request headers carry the token minted by `/auto` to the inner stream |
| Session model identity | Streamed/saved responses keep the Auto provider and selected tier; non-secret route metadata restores native history for subsequent requests |
| `session.compacted` (invalidate) | `pi.on("session_compact", …)` clears only the compacted classic Auto conversation cache; Fusion keeps its anchor |
| Real user turns | `pi.on("context", …)` records real user messages; `pi.on("session_tree", …)` drops the Fusion anchor |

Token exchange and the Copilot request construction (endpoint paths, `X-Initiator`,
vision headers, Bearer auth) reuse pi's built‑in `github-copilot` provider logic —
the plugin only runs the `/auto` router and delegates.

## License

MIT (same as the original opencode plugin).
