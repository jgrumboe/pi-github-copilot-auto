# pi-github-copilot-auto

Adds a **`github-copilot-auto/auto`** model to [pi](https://github.com/earendil-works/pi)
that follows GitHub Copilot's own server‑side auto model selection — including the
per‑turn **intent router** that VS Code uses.

This is a port of
[opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model)
to pi's extension/provider API.

## How it works

GitHub Copilot "auto" uses two server calls on the Copilot API host:

1. `POST /models/session` — opens an auto session and returns the candidate model pool
   (`available_models`) plus a `Copilot-Session-Token`.
2. `POST /models/session/intent` — the intent router, which classifies the prompt and
   returns `candidate_models` and `chosen_model`.

This package opens the auto session, asks the intent router, and then delegates the
request to the selected model through pi's provider stream.
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

Pick **`github-copilot-auto/auto`**.

Or run from shell:

```bash
pi --provider github-copilot-auto --model auto
```

### 5) Verify package install (optional)

```bash
pi list
```


## Usage

The routing decision for each conversation is shown as a transient toast
(`Auto → gpt-5.4 · no_reasoning`) and in the footer status (`auto → gpt-5.4`).

### Routing behaviour

- **Turn 0** of a conversation calls the intent router and picks a model.
- **Turns 1+** reuse that pick (KV‑cache stability, like VS Code).
- If the chosen model fails with a **retriable upstream error** (429/5xx/timeout/network),
  the plugin tries the next Copilot-provided candidates for that turn.
- **After compaction**, only the compacted conversation's routing cache is invalidated
  and re-evaluated next turn.

## Models in the auto pool

The following models are available under GitHub Copilot's Auto model selection.
The actual pool returned per request may vary by plan and policy.

| Model | Provider |
|-------|----------|
| GPT-5 mini | OpenAI |
| GPT-5.3-Codex | OpenAI |
| GPT-5.4 | OpenAI |
| GPT-5.4 mini | OpenAI |
| Claude Haiku 4.5 | Anthropic |
| Claude Sonnet 4.6 | Anthropic |
| MAI-Code-1-Flash | Microsoft |
| Raptor mini | Microsoft |

> Source: [Supported AI models in GitHub Copilot — Auto model selection](https://docs.github.com/en/copilot/reference/ai-models/supported-models#supported-ai-models-in-auto-model-selection)  
> Model availability is subject to change.

## Optional configuration

Create `~/.pi/agent/github-copilot-auto.json` (all fields optional):

```jsonc
{
  // The auto picker entry advertises these limits to pi's context manager.
  // Keep contextWindow conservative if your pool mixes 200K and 1M models.
  "contextWindow": 200000,
  "maxTokens": 64000,

  // Write routing decisions to a log file (see below).
  "debug": false
}
```

| Option | Type | Description |
|--------|------|-------------|
| `contextWindow` | number | Context window advertised for the `auto` entry (default 200000). |
| `maxTokens` | number | Max output tokens advertised for the `auto` entry (default 64000). |
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
| `provider.models` (inject `auto`) | `pi.registerProvider("github-copilot-auto", { models:[auto] })` |
| `chat.message` (capture prompt) | last user message read from `Context.messages` in `streamSimple` |
| `chat.params` (override model id) | `streamSimple` picks the model and delegates to its native stream |
| `chat.headers` (session token) | `options.headers["Copilot-Session-Token"]` passed to the inner stream |
| `session.compacted` (invalidate) | `pi.on("session_compact", …)` clears only the compacted conversation cache |

Token exchange and the Copilot request construction (endpoint paths, `X-Initiator`,
vision headers, Bearer auth) reuse pi's built‑in `github-copilot` provider logic —
the plugin only opens the auto session, runs the router, and delegates.

## License

MIT (same as the original opencode plugin).
