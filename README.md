# pi-github-copilot-auto

Adds a **`github-copilot-auto/auto`** model to [pi](https://github.com/earendil-works/pi)
that follows GitHub Copilot's own server‑side auto model selection — including the
per‑turn **intent router** that VS Code uses.

This is a port of
[opencode-github-copilot-auto-model](https://github.com/m0wer/opencode-github-copilot-auto-model)
to pi's extension/provider API.

## Why it works better on pi than on opencode

GitHub Copilot "auto" is backed by two server calls on the Copilot API host:

1. `POST /models/session` — opens an auto session: returns the candidate model pool
   (`available_models`) and a `Copilot-Session-Token` (places requests in the auto
   billing/rate‑limit pool, with the ~10% discount).
2. `POST /models/session/intent` — the **intent router**: classifies the prompt as
   `needs_reasoning` / `no_reasoning` and returns a ranked `candidate_models` list
   plus a `chosen_model`.

The intent router is **gated to first‑party clients**. opencode's OAuth client ID
gets a `404`, so its plugin usually falls back to the plain availability pick.

**pi already authenticates its GitHub Copilot provider as
`Copilot-Integration-Id: vscode-chat` using VS Code's GitHub App client ID** — which
is exactly the gate the router checks. So this plugin gets *genuine* per‑prompt ML
routing decisions.

Second advantage: pi lets the plugin implement a custom `streamSimple`, so each routed
turn delegates to the **target model's own endpoint family**. There is no single‑endpoint
"within‑family" constraint — Claude for reasoning **and** GPT for fast both work in the
same picker entry (the opencode port could not do this without a proxy).

## Install (first-time pi users)

This extension is loaded from pi's global auto-discovery directory
(`~/.pi/agent/extensions/`).

### 1) Clone the plugin into pi's extensions folder

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/redbullmediahouse-playground/pi-github-copilot-auto.git \
  ~/.pi/agent/extensions/github-copilot-auto
```

### 2) Start pi and reload extensions

```text
/reload
```

(If pi was not running yet, just start `pi`; no extra build step is needed.)

### 3) Log in to GitHub Copilot once in pi

```text
/login
```

Then choose **GitHub Copilot** in the login flow.

The plugin reuses those credentials from `~/.pi/agent/auth.json` (including token
refresh). No separate auth flow is required.

### 4) Select the model

```text
/model
```

Pick **`github-copilot-auto/auto`**.

You can also run directly from shell:

```bash
pi --provider github-copilot-auto --model auto
```

## Usage

Pick **`github-copilot-auto/auto`** in the model picker (`/model`), or:

```sh
pi --provider github-copilot-auto --model auto
```

The routing decision for each conversation is shown as a transient toast
(`Auto → gpt-5.4 · no_reasoning`) and in the footer status (`auto → gpt-5.4`).

### Routing behaviour

- **Turn 0** of a conversation calls the intent router and picks a model.
- **Turns 1+** reuse that pick (KV‑cache stability, like VS Code).
- If the chosen model fails with a **retriable upstream error** (429/5xx/timeout/network),
  the plugin tries the next Copilot-provided candidates for that turn.
- **After compaction**, only the compacted conversation's routing cache is invalidated
  and re-evaluated next turn.

## Pure auto mode

This plugin now runs in **pure auto** mode only:

- No local preference override (`preferredModels`, `reasoning`, `noReasoning` removed)
- No local effort override (`boostReasoningEffort` removed)
- Selection follows Copilot's router/session output (`chosen_model`, `candidate_models`,
  then session defaults) and policy-filtered pool

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
