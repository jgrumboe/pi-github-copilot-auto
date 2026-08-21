/**
 * GitHub Copilot Auto model for pi
 * ================================
 *
 * Adds `github-copilot-auto/auto` models that follow GitHub Copilot's own
 * server-side auto model selection — the single-call **AutoV2 router** that
 * current VS Code uses (`POST /auto`).
 *
 * Port of https://github.com/m0wer/opencode-github-copilot-auto-model to pi,
 * evolved to the newer `POST /auto` endpoint.
 *
 * `POST /auto` takes the prompt (plus an optional routing `tier`) and, in one
 * round-trip, both picks the model and mints the `Copilot-Session-Token` the
 * chat request bills against. It returns the full metadata of the selected
 * model, so the routable pool includes newer models that never appeared in the
 * legacy `POST /models/session` pool (e.g. gpt-5.6-*, claude-opus-5,
 * claude-sonnet-5).
 *
 * Routing tiers (from VS Code's `autoModeTiers`): `eco`, `balanced`, `max`.
 * The tier biases which models the router may choose from. Users pick a tier
 * by selecting one of the registered `auto-*` models, or set a default in
 * config. (`fast` is VS Code's internal inline-chat tier and is only reachable
 * through the `tier` config override.)
 *
 * Why this works on pi:
 *   - pi's built-in GitHub Copilot provider already authenticates as
 *     `Copilot-Integration-Id: vscode-chat` using VS Code's GitHub App client ID.
 *     That is the first-party gate the router checks, so `/auto` returns real
 *     ML routing decisions (a third-party client ID gets a 404).
 *   - pi lets us implement a custom `streamSimple`, so each routed turn delegates
 *     to the *target model's own* endpoint family. There is no single-endpoint
 *     "within-family" constraint: Claude for reasoning + GPT for fast both work.
 *
 * Requirements: run `/login` and authenticate with GitHub Copilot first.
 *
 * Optional config: ~/.pi/agent/github-copilot-auto.json
 *   {
 *     "contextWindow": 200000,
 *     "maxTokens": 64000,
 *     "tier": "balanced",
 *     "debug": false
 *   }
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getModels,
	type Model,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "github-copilot-auto";
const MODEL_ID = "auto";
const SOURCE_PROVIDER = "github-copilot";

const COPILOT_API_VERSION = "2026-08-01";
const AUTO_TIMEOUT_MS = 5000;
const SESSION_REFRESH_SKEW_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

// Routing profiles accepted by `POST /auto` (VS Code's `autoModeTiers`). A tier
// biases which models the router may choose from.
const AUTO_MODE_TIERS = ["eco", "balanced", "max", "fast"] as const;
type AutoModeTier = (typeof AUTO_MODE_TIERS)[number];
// Tiers offered as pickable `auto-*` models. `fast` is VS Code's internal
// inline-chat default and is intentionally not offered as a picker choice.
const SELECTABLE_TIERS: readonly AutoModeTier[] = ["eco", "balanced", "max"];
const DEFAULT_TIER: AutoModeTier = "balanced";

function isTier(value: unknown): value is AutoModeTier {
	return typeof value === "string" && (AUTO_MODE_TIERS as readonly string[]).includes(value);
}

// Identity headers VS Code stamps on the gated auto-mode CAPI calls. pi already
// sends Copilot-Integration-Id: vscode-chat (the gate); these add the rest.
const COPILOT_BASE_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.43.0",
	"Editor-Version": "vscode/1.134.0",
	"Editor-Plugin-Version": "copilot-chat/0.43.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const VSCODE_SESSION_ID = `${randomUUID()}${Date.now()}`;
const VSCODE_MACHINE_ID = randomUUID().replace(/-/g, "");
const VSCODE_DEVICE_ID = randomUUID();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Config = {
	contextWindow?: number;
	maxTokens?: number;
	/** Default routing tier for the bare `auto` model. Defaults to `balanced`. */
	tier?: AutoModeTier;
	debug?: boolean;
};

function loadConfig(): Config {
	const file = path.join(homedir(), ".pi", "agent", "github-copilot-auto.json");
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Config;
	} catch {
		return {};
	}
}

const config = loadConfig();
const defaultTier: AutoModeTier = isTier(config.tier) ? config.tier : DEFAULT_TIER;

// ---------------------------------------------------------------------------
// File logger (keeps the TUI clean). Tail:
//   ~/.local/state/github-copilot-auto/plugin.log
// ---------------------------------------------------------------------------

function logFile(): string {
	if (process.platform === "win32") {
		return path.join(
			process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
			"github-copilot-auto",
			"plugin.log",
		);
	}
	const xdg = process.env.XDG_STATE_HOME;
	return path.join(xdg ?? path.join(homedir(), ".local", "state"), "github-copilot-auto", "plugin.log");
}

let logReady: Promise<void> | undefined;
function log(msg: string): void {
	if (!config.debug) return;
	const file = logFile();
	if (!logReady) {
		logReady = mkdir(path.dirname(file), { recursive: true })
			.then(() => undefined)
			.catch(() => undefined);
	}
	void logReady.then(() => appendFile(file, `${new Date().toISOString()} ${msg}\n`).catch(() => undefined));
}

// ---------------------------------------------------------------------------
// Auth: reuse pi's existing github-copilot OAuth credentials from auth.json
// ---------------------------------------------------------------------------

type CopilotCreds = {
	type?: string;
	refresh?: string; // GitHub OAuth token (gho_...)
	access?: string; // short-lived Copilot API token
	expires?: number; // ms epoch
	enterpriseUrl?: string;
};

type ResolvedToken = { token: string; baseUrl: string; expires: number };

let cachedToken: ResolvedToken | undefined;
let tokenInflight: Promise<ResolvedToken | undefined> | undefined;

function authFilePath(): string {
	return path.join(homedir(), ".pi", "agent", "auth.json");
}

function baseUrlFromToken(token: string, enterpriseDomain?: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (match) return `https://${match[1].replace(/^proxy\./, "api.")}`;
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

async function readCreds(): Promise<CopilotCreds | undefined> {
	try {
		const raw = await readFile(authFilePath(), "utf8");
		const auth = JSON.parse(raw) as Record<string, CopilotCreds>;
		return auth[SOURCE_PROVIDER];
	} catch {
		return undefined;
	}
}

async function exchangeCopilotToken(refresh: string, enterpriseDomain?: string): Promise<ResolvedToken | undefined> {
	const domain = enterpriseDomain || "github.com";
	const url = `https://api.${domain}/copilot_internal/v2/token`;
	const res = await fetch(url, {
		headers: { Accept: "application/json", Authorization: `Bearer ${refresh}`, ...COPILOT_BASE_HEADERS },
	}).catch((e) => {
		log(`token exchange failed: ${String(e)}`);
		return undefined;
	});
	if (!res || !res.ok) {
		log(`token exchange non-ok: ${res?.status}`);
		return undefined;
	}
	const data = (await res.json().catch(() => undefined)) as { token?: string; expires_at?: number } | undefined;
	if (!data || typeof data.token !== "string") return undefined;
	const expires = (data.expires_at ?? Math.floor(Date.now() / 1000) + 25 * 60) * 1000 - TOKEN_REFRESH_SKEW_MS;
	return { token: data.token, baseUrl: baseUrlFromToken(data.token, enterpriseDomain), expires };
}

async function ensureToken(): Promise<ResolvedToken | undefined> {
	if (cachedToken && Date.now() < cachedToken.expires) return cachedToken;
	if (tokenInflight) return tokenInflight;

	tokenInflight = (async () => {
		const creds = await readCreds();
		if (!creds) {
			log("no github-copilot credentials in auth.json (run /login)");
			return undefined;
		}
		const enterprise = creds.enterpriseUrl;
		// Use the still-valid cached Copilot access token if present.
		if (creds.access && creds.expires && Date.now() < creds.expires - TOKEN_REFRESH_SKEW_MS) {
			cachedToken = {
				token: creds.access,
				baseUrl: baseUrlFromToken(creds.access, enterprise),
				expires: creds.expires - TOKEN_REFRESH_SKEW_MS,
			};
			return cachedToken;
		}
		// Otherwise mint a fresh one from the GitHub OAuth token.
		if (!creds.refresh) return undefined;
		const fresh = await exchangeCopilotToken(creds.refresh, enterprise);
		if (fresh) cachedToken = fresh;
		return cachedToken;
	})().finally(() => {
		tokenInflight = undefined;
	});

	return tokenInflight;
}

// ---------------------------------------------------------------------------
// Copilot auto session + intent router
// ---------------------------------------------------------------------------

function capiHeaders(token: string, sessionToken?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"X-GitHub-Api-Version": COPILOT_API_VERSION,
		...COPILOT_BASE_HEADERS,
		"VScode-SessionId": VSCODE_SESSION_ID,
		"VScode-MachineId": VSCODE_MACHINE_ID,
		"Editor-Device-Id": VSCODE_DEVICE_ID,
	};
	if (sessionToken) headers["Copilot-Session-Token"] = sessionToken;
	return headers;
}

/**
 * The model embedded in a `POST /auto` response. Same shape as a `GET /models`
 * entry, but only `id` is guaranteed; `capabilities.type`/vendor help us map an
 * unknown id onto the right endpoint family.
 */
type AutoSelectedModel = {
	id: string;
	vendor?: string;
	name?: string;
	capabilities?: {
		family?: string;
		supports?: { tool_calls?: boolean; vision?: boolean; streaming?: boolean };
		limits?: { max_prompt_tokens?: number; max_output_tokens?: number };
	};
};

type AutoDecision = {
	sessionToken: string;
	selectedModel: AutoSelectedModel;
	expiresAtMs: number;
	hydraScores?: Record<string, number>;
};

/**
 * Single-call AutoV2 router. Routes the prompt to a concrete model and mints the
 * session token the chat request bills against — all in one round-trip.
 */
async function fetchAutoDecision(
	baseUrl: string,
	token: string,
	prompt: string,
	opts: { tier: AutoModeTier; hasImage?: boolean; conversationId?: string },
): Promise<AutoDecision | undefined> {
	const body: Record<string, unknown> = { prompt };
	// `fast` is a server default; only send an explicit tier for the rest so the
	// server can fall back to its own default if a tier is ever retired.
	if (opts.tier) body.tier = opts.tier;
	if (opts.hasImage) body.has_image = true;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), AUTO_TIMEOUT_MS);
	let res: Response | undefined;
	try {
		res = await fetch(`${baseUrl}/auto`, {
			method: "POST",
			headers: capiHeaders(token),
			body: JSON.stringify(body),
			signal: ac.signal,
		});
	} catch (e) {
		log(`auto fetch failed: ${String(e)}`);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
	if (!res || !res.ok) {
		log(`auto fetch non-ok: ${res?.status} ${res ? await res.text().catch(() => "") : ""}`);
		return undefined;
	}
	const data = (await res.json().catch(() => undefined)) as
		| { session_token?: string; selected_model?: AutoSelectedModel; expires_at?: number; hydra_scores?: Record<string, number> }
		| undefined;
	if (!data || typeof data.session_token !== "string" || !data.selected_model?.id) {
		log(`auto response missing session_token or selected_model: ${JSON.stringify(data)}`);
		return undefined;
	}
	const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 24 * 60 * 60_000;
	log(
		`auto: tier=${opts.tier} selected=${data.selected_model.id} scores=${JSON.stringify(data.hydra_scores ?? {})} expires=${new Date(expiresAtMs).toISOString()}`,
	);
	return {
		sessionToken: data.session_token,
		selectedModel: data.selected_model,
		expiresAtMs,
		hydraScores: data.hydra_scores,
	};
}

// ---------------------------------------------------------------------------
// Model catalog + routing selection
// ---------------------------------------------------------------------------

const catalog = new Map<string, Model<Api>>();
for (const m of getModels(SOURCE_PROVIDER) as Model<Api>[]) catalog.set(m.id, m);

function dedupe(values: string[]): string[] {
	const out: string[] = [];
	for (const value of values) {
		if (!value || out.includes(value)) continue;
		out.push(value);
	}
	return out;
}

/**
 * Infers the pi API family for a model the built-in catalog does not know about
 * (e.g. a freshly released `/auto` pick). Falls back to OpenAI completions,
 * which the Copilot host accepts for every chat model.
 */
function inferApi(selected: AutoSelectedModel): Api {
	const hint = `${selected.vendor ?? ""} ${selected.id} ${selected.capabilities?.family ?? ""}`.toLowerCase();
	if (hint.includes("anthropic") || hint.includes("claude")) return "anthropic-messages";
	// GPT-5-era models speak the Responses API; older gpt-4* use completions.
	if (/gpt-5|gpt-6|codex|\bo[134]\b/.test(hint)) return "openai-responses";
	return "openai-completions";
}

/**
 * Resolves the model the router selected to a pi `Model` we can delegate to.
 * Known ids reuse the built-in catalog entry; unknown ids are synthesized from
 * the metadata `/auto` returns so newer models remain routable.
 */
function resolveTargetModel(selected: AutoSelectedModel, baseUrl: string): Model<Api> {
	const known = catalog.get(selected.id);
	if (known) return { ...known, provider: SOURCE_PROVIDER, baseUrl };

	const limits = selected.capabilities?.limits;
	const synthetic: Model<Api> = {
		id: selected.id,
		name: selected.name ?? selected.id,
		api: inferApi(selected),
		provider: SOURCE_PROVIDER,
		baseUrl,
		reasoning: true,
		input: selected.capabilities?.supports?.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: limits?.max_prompt_tokens ?? config.contextWindow ?? 200000,
		maxTokens: limits?.max_output_tokens ?? config.maxTokens ?? 64000,
	} as Model<Api>;
	log(`synthesized target for unknown model ${selected.id} as api=${synthetic.api}`);
	return synthetic;
}

/**
 * Fallback attempt order for a routed turn. `/auto` returns a single model, so
 * resilience comes from appending known catalog models as last resorts — tried
 * only when the routed model fails with a retriable upstream error.
 */
function buildFallbackOrder(primaryId: string): string[] {
	return dedupe([primaryId, ...catalog.keys()]);
}

function isRetriableProviderError(message: string): boolean {
	const text = message.toLowerCase();
	return (
		/\b(429|500|502|503|504|408)\b/.test(text) ||
		text.includes("rate limit") ||
		text.includes("temporarily unavailable") ||
		text.includes("overloaded") ||
		text.includes("timeout") ||
		text.includes("timed out") ||
		text.includes("econnreset") ||
		text.includes("socket hang up") ||
		text.includes("network")
	);
}

// ---------------------------------------------------------------------------
// Per-conversation routing + session state (keyed by options.sessionId)
// ---------------------------------------------------------------------------

type ConvState = {
	/** The routed decision, cached for the life of the conversation (24h token). */
	decision?: AutoDecision;
	decisionInflight?: Promise<AutoDecision | undefined>;
	/** Resolved target model for {@link decision}. */
	routedModel?: Model<Api>;
	/** Tier the cached decision was routed under; a tier change re-routes. */
	routedTier?: AutoModeTier;
	turn: number;
};

const conversations = new Map<string, ConvState>();

function getConv(key: string): ConvState {
	let c = conversations.get(key);
	if (!c) {
		c = { turn: 0 };
		conversations.set(key, c);
	}
	return c;
}

function hasImageInput(context: Context): boolean {
	for (const msg of context.messages) {
		if (msg.role !== "user" || typeof msg.content === "string") continue;
		if (msg.content.some((c) => c.type === "image")) return true;
	}
	return false;
}

/**
 * Routes the conversation through `POST /auto`, caching the decision for the
 * life of the session token. Re-routes when the tier changes, the token nears
 * expiry, or {@link force} is set (e.g. after compaction).
 */
async function ensureDecision(
	conv: ConvState,
	baseUrl: string,
	token: string,
	prompt: string,
	tier: AutoModeTier,
	hasImage: boolean,
	conversationId: string,
	force: boolean,
): Promise<AutoDecision | undefined> {
	const fresh = conv.decision && Date.now() < conv.decision.expiresAtMs - SESSION_REFRESH_SKEW_MS;
	if (!force && fresh && conv.routedTier === tier) return conv.decision;
	if (conv.decisionInflight) return conv.decisionInflight;

	conv.decisionInflight = fetchAutoDecision(baseUrl, token, prompt, { tier, hasImage, conversationId })
		.then((d) => {
			if (d) {
				conv.decision = d;
				conv.routedTier = tier;
				conv.routedModel = resolveTargetModel(d.selectedModel, baseUrl);
			}
			return conv.decision;
		})
		.finally(() => {
			conv.decisionInflight = undefined;
		});
	return conv.decisionInflight;
}

function lastUserPrompt(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") return msg.content.trim();
		return msg.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text?: string }).text ?? "")
			.join("\n")
			.trim();
	}
	return "";
}

function countAssistantTurns(context: Context): number {
	return context.messages.filter((m) => m.role === "assistant").length;
}

// ---------------------------------------------------------------------------
// UI surface (route shown as a transient toast + footer status)
// ---------------------------------------------------------------------------

let uiNotify: ((msg: string, variant: "info" | "success" | "warning" | "error") => void) | undefined;
let uiStatus: ((key: string, text: string) => void) | undefined;

function announce(modelId: string, tier: AutoModeTier): void {
	uiNotify?.(`Auto (${tier}) → ${modelId}`, tier === "max" ? "success" : "info");
	uiStatus?.("copilot-auto", `auto:${tier} → ${modelId}`);
}

// ---------------------------------------------------------------------------
// streamSimple: route, then delegate to the target model's native stream
// ---------------------------------------------------------------------------

function errorStream(message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: PROVIDER_ID as Api,
			provider: PROVIDER_ID,
			model: MODEL_ID,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	});
	stream.end();
	return stream;
}

function delegateStream(
	target: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	token: string,
	sessionToken: string,
): AssistantMessageEventStream {
	const headers = { ...(options?.headers ?? {}), "Copilot-Session-Token": sessionToken };
	// Override the placeholder provider apiKey with the resolved Copilot token.
	const innerOptions: SimpleStreamOptions = { ...options, apiKey: token, headers };

	switch (target.api) {
		case "anthropic-messages":
			return streamSimpleAnthropic(target as Model<"anthropic-messages">, context, innerOptions);
		case "openai-responses":
			return streamSimpleOpenAIResponses(target as Model<"openai-responses">, context, innerOptions);
		case "openai-completions":
			return streamSimpleOpenAICompletions(target as Model<"openai-completions">, context, innerOptions);
		default:
			// Most Copilot models are one of the three above; fall back to completions.
			return streamSimpleOpenAICompletions(target as Model<"openai-completions">, context, innerOptions);
	}
}

/** Maps a registered model id (`auto`, `auto-max`, …) to a routing tier. */
function tierForModelId(modelId: string): AutoModeTier {
	if (modelId === MODEL_ID) return defaultTier;
	const suffix = modelId.startsWith(`${MODEL_ID}-`) ? modelId.slice(MODEL_ID.length + 1) : "";
	return isTier(suffix) ? suffix : defaultTier;
}

function streamAuto(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	(async () => {
		try {
			const auth = await ensureToken();
			if (!auth) {
				for await (const e of errorStream("GitHub Copilot not authenticated. Run /login and select GitHub Copilot."))
					out.push(e);
				out.end();
				return;
			}

			const convKey = options?.sessionId ?? "default";
			const conv = getConv(convKey);
			const tier = tierForModelId(model.id);

			// Sticky routing: route once per conversation and reuse the pick (and its
			// 24h session token) for KV-cache stability, like VS Code. Re-route after
			// compaction (assistant turn count drops back toward 0) or a tier change.
			const assistantTurns = countAssistantTurns(context);
			const force = assistantTurns === 0 || conv.routedTier !== tier;
			const prompt = lastUserPrompt(context);
			if (!prompt && !conv.decision) {
				for await (const e of errorStream("Auto mode needs a prompt to route a request.")) out.push(e);
				out.end();
				return;
			}

			const decision = prompt
				? await ensureDecision(conv, auth.baseUrl, auth.token, prompt, tier, hasImageInput(context), convKey, force)
				: conv.decision;
			if (!decision || !conv.routedModel) {
				for await (const e of errorStream("Failed to route a GitHub Copilot auto model (POST /auto).")) out.push(e);
				out.end();
				return;
			}

			const routedId = conv.routedModel.id;
			if (force) {
				announce(routedId, tier);
				log(`routed ${convKey} -> ${routedId} (tier=${tier})`);
			}

			conv.turn += 1;

			// The routed model is the primary; known catalog models are appended as
			// last-resort fallbacks, tried only on a retriable upstream error.
			const attemptIds = buildFallbackOrder(routedId);
			let lastErrorEvent: { type: "error"; error?: { errorMessage?: string } } | undefined;

			for (let i = 0; i < attemptIds.length; i++) {
				const attemptId = attemptIds[i];
				const target =
					attemptId === routedId
						? conv.routedModel
						: (() => {
								const base = catalog.get(attemptId);
								return base ? ({ ...base, provider: SOURCE_PROVIDER, baseUrl: auth.baseUrl } as Model<Api>) : undefined;
							})();
				if (!target) continue;

				const inner = delegateStream(target, context, options, auth.token, decision.sessionToken);

				let committed = false;
				let sawError = false;
				let errorMessage = "";
				const preCommitBuffer: unknown[] = [];

				for await (const event of inner as AsyncIterable<unknown>) {
					const ev = event as { type?: string; error?: { errorMessage?: string } };
					if (!committed) {
						if (ev.type === "error") {
							sawError = true;
							errorMessage = ev.error?.errorMessage ?? "Unknown upstream error";
							lastErrorEvent = ev as { type: "error"; error?: { errorMessage?: string } };
							break;
						}
						preCommitBuffer.push(event);
						if (ev.type && ev.type !== "start") {
							committed = true;
							for (const buffered of preCommitBuffer) out.push(buffered as never);
						}
						continue;
					}
					out.push(event as never);
				}

				if (sawError && !committed) {
					const retriable = isRetriableProviderError(errorMessage);
					const hasAnother = i < attemptIds.length - 1;
					log(
						`attempt failed ${attemptId} retriable=${String(retriable)} next=${String(hasAnother)} msg=${errorMessage}`,
					);
					if (retriable && hasAnother) continue;
					if (lastErrorEvent) out.push(lastErrorEvent as never);
					else for await (const e of errorStream(errorMessage)) out.push(e as never);
					out.end();
					return;
				}

				if (!committed) {
					for (const buffered of preCommitBuffer) out.push(buffered as never);
				}

				if (attemptId !== routedId) {
					announce(attemptId, tier);
					log(`fallback promoted ${routedId} -> ${attemptId}`);
				}
				out.end();
				return;
			}

			for await (const e of errorStream("All candidate auto models failed.")) out.push(e);
			out.end();
		} catch (e) {
			for await (const ev of errorStream(e instanceof Error ? e.message : String(e))) out.push(ev);
			out.end();
		}
	})();

	return out;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const autoModel = (id: string, name: string) => ({
		id,
		name,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow ?? 200000,
		maxTokens: config.maxTokens ?? 64000,
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "GitHub Copilot (Auto)",
		baseUrl: "https://api.individual.githubcopilot.com",
		// Auth is resolved internally from the existing github-copilot login; this
		// literal keeps pi from treating the provider as unconfigured.
		apiKey: "copilot-auto",
		api: "openai-completions",
		streamSimple: streamAuto as never,
		models: [
			// Bare `auto` follows the configured default tier (balanced unless set).
			autoModel(MODEL_ID, `Auto (${defaultTier})`),
			// One entry per pickable tier so users choose via `/model`.
			...SELECTABLE_TIERS.map((t) => autoModel(`${MODEL_ID}-${t}`, `Auto (${t})`)),
		],
	});

	// Capture UI helpers so streamSimple (which has no ctx) can surface the route.
	const capture = (ctx: { ui?: { notify?: unknown; setStatus?: unknown } }) => {
		const ui = ctx.ui as
			| {
					notify?: (m: string, v: "info" | "success" | "warning" | "error") => void;
					setStatus?: (k: string, t: string) => void;
			  }
			| undefined;
		if (ui?.notify) uiNotify = (m, v) => ui.notify?.(m, v);
		if (ui?.setStatus) uiStatus = (k, t) => ui.setStatus?.(k, t);
	};

	pi.on("session_start", async (_e, ctx) => capture(ctx as never));

	const compactedSessionKey = (event: unknown): string | undefined => {
		if (!event || typeof event !== "object") return undefined;
		const e = event as {
			sessionID?: unknown;
			sessionId?: unknown;
			properties?: { sessionID?: unknown; sessionId?: unknown };
		};
		const direct = typeof e.sessionID === "string" ? e.sessionID : typeof e.sessionId === "string" ? e.sessionId : undefined;
		if (direct) return direct;
		return typeof e.properties?.sessionID === "string"
			? e.properties.sessionID
			: typeof e.properties?.sessionId === "string"
				? e.properties.sessionId
				: undefined;
	};

	// Reset sticky routing only for the compacted conversation.
	pi.on("session_compact", async (event, ctx) => {
		capture(ctx as never);
		const key = compactedSessionKey(event);
		if (key) {
			conversations.delete(key);
			log(`routing cache cleared for compacted session ${key}`);
			return;
		}
		// Fallback for unknown payload shapes.
		conversations.clear();
		log("routing cache cleared (compaction fallback: unknown session key)");
	});
}
