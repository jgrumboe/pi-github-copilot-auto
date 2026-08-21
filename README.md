# pi-github-copilot-auto

Adds **`github-copilot-auto/auto`** models to [pi](https://github.com/earendil-works/pi)
that follow GitHub Copilot's own server‑side auto model selection — the single‑call
**AutoV2 router** (`POST /auto`) that current VS Code uses.

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
| `eco` | Cheapest / lightest models |
| `balanced` | Default — sensible cost/quality trade‑off |
| `max` | Prefer the most capable models |

You pick a tier by **selecting one of the registered models**:

| Model id | Tier used |
|----------|-----------|
| `github-copilot-auto/auto` | The configured default (`balanced` unless overridden) |
| `github-copilot-auto/auto-eco` | `eco` |
| `github-copilot-auto/auto-balanced` | `balanced` |
| `github-copilot-auto/auto-max` | `max` |

Switching between them mid‑conversation re‑routes on the next turn. You can also
change the default that the bare `auto` model uses via the `tier` config option
(see below). VS Code's internal `fast` tier is not offered as a picker entry but
can be forced through the `tier` config value.
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

- **`github-copilot-auto/auto`** — default tier (`balanced`)
- **`github-copilot-auto/auto-eco`** — cheapest models
- **`github-copilot-auto/auto-balanced`** — balanced routing
- **`github-copilot-auto/auto-max`** — most capable models

Or run from shell:

```bash
pi --provider github-copilot-auto --model auto-max
```

### 5) Verify package install (optional)

```bash
pi list
```


## Usage

The routing decision for each conversation is shown as a transient toast
(`Auto (max) → claude-sonnet-5`) and in the footer status (`auto:max → claude-sonnet-5`).

### Routing behaviour

- **Turn 0** of a conversation calls `POST /auto` and picks a model for the tier.
- **Turns 1+** reuse that pick and its session token (KV‑cache stability, like
  VS Code). The session token lasts 24h with no refresh.
- **Changing tier** (selecting a different `auto-*` model) re‑routes next turn.
- If the chosen model fails with a **retriable upstream error** (429/5xx/timeout/network),
  the plugin falls back to other known Copilot models for that turn.
- **After compaction**, the compacted conversation's routing cache is invalidated
  and re‑evaluated next turn.

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

  // Default routing tier for the bare `auto` model: "eco" | "balanced" | "max".
  // ("fast" is VS Code's internal inline-chat tier; usable but not recommended.)
  "tier": "balanced",

  // Write routing decisions to a log file (see below).
  "debug": false
}
```

| Option | Type | Description |
|--------|------|-------------|
| `contextWindow` | number | Context window advertised for the `auto` entries (default 200000). |
| `maxTokens` | number | Max output tokens advertised for the `auto` entries (default 64000). |
| `tier` | string | Default tier for the bare `auto` model (default `balanced`). |
| `debug` | boolean | Enable the debug log. |

## Debugging

With `"debug": true`, decisions are appended to:

- macOS/Linux: `~/.local/state/github-copilot-auto/plugin.log`
- Windows: `%LOCALAPPDATA%\github-copilot-auto\plugin.log`

```sh
tail -f ~/.local/state/github-copilot-auto/plugin.log
```

## How it maps to pi

| opencode hook | pi equivalent used here |
|---------------|--------------------------|
| `provider.models` (inject `auto`) | `pi.registerProvider("github-copilot-auto", { models:[auto, auto-eco, auto-balanced, auto-max] })` |
| `chat.message` (capture prompt) | last user message read from `Context.messages` in `streamSimple` |
| `chat.params` (override model id) | `streamSimple` routes via `POST /auto` and delegates to the selected model's native stream |
| `chat.headers` (session token) | `options.headers["Copilot-Session-Token"]` (minted by `/auto`) passed to the inner stream |
| `session.compacted` (invalidate) | `pi.on("session_compact", …)` clears only the compacted conversation cache |

Token exchange and the Copilot request construction (endpoint paths, `X-Initiator`,
vision headers, Bearer auth) reuse pi's built‑in `github-copilot` provider logic —
the plugin only runs the `/auto` router and delegates.

## License

MIT (same as the original opencode plugin).
