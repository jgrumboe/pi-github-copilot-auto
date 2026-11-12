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
 * Routing tiers (from VS Code's `autoModeTiers`): `efficiency`, `balance`,
 * `intelligence`. Legacy config/session tier values (`eco`, `balanced`, `max`)
 * are normalized internally but are no longer registered as picker entries. The
 * tier biases which models the router may choose from. Users pick a tier by
 * selecting one of the registered `auto-*` models, or set a default in config.
 * (`fast` is VS Code's internal inline-chat tier and is only reachable through
 * the `tier` config override.)
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
 *     "tier": "balance",
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
import { asAutoEvent, asFusionEvent, restoreAutoContext, restoreFusionContext } from "./auto-identity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "github-copilot-auto";
const MODEL_ID = "auto";
const FUSION_PROVIDER_ID = "github-copilot-fusion";
const FUSION_MODEL_ID = "standard";
const SOURCE_PROVIDER = "github-copilot";

const COPILOT_API_VERSION = "2026-08-01";
const COPILOT_META_API_VERSION = "2026-09-21";
const AUTO_TIMEOUT_MS = 5000;
const SESSION_REFRESH_SKEW_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

// Routing profiles accepted by `POST /auto` (VS Code's current
// `autoModeTiers`). The old names still route server-side, but current VS Code
// normalizes them before sending. Use current names on the wire.
const AUTO_MODE_TIERS = ["efficiency", "balance", "intelligence", "fast"] as const;
type AutoModeTier = (typeof AUTO_MODE_TIERS)[number];
const LEGACY_TIER_ALIASES: Readonly<Record<string, AutoModeTier>> = {
	eco: "efficiency",
	balanced: "balance",
	max: "intelligence",
};
// Tiers offered as pickable `auto-*` models. `fast` is VS Code's internal
// inline-chat default and is intentionally not offered as a picker choice.
const SELECTABLE_TIERS: readonly AutoModeTier[] = ["efficiency", "balance", "intelligence"];
const DEFAULT_TIER: AutoModeTier = "balance";

function normalizeTier(value: unknown): AutoModeTier | undefined {
	if (typeof value !== "string") return undefined;
	const tier = LEGACY_TIER_ALIASES[value] ?? value;
	return (AUTO_MODE_TIERS as readonly string[]).includes(tier) ? tier as AutoModeTier : undefined;
}

// Identity headers VS Code stamps on the gated auto-mode CAPI calls. pi already
// sends Copilot-Integration-Id: vscode-chat (the gate); these add the rest.
const COPILOT_BASE_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.67.0",
	"Editor-Version": "vscode/1.139.0",
	"Editor-Plugin-Version": "copilot-chat/0.67.0",
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
	/** Default routing tier for the bare `auto` model. Defaults to `balance`. */
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
const defaultTier: AutoModeTier = normalizeTier(config.tier) ?? DEFAULT_TIER;

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
		signal: AbortSignal.timeout(AUTO_TIMEOUT_MS),
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

/** Check Standard availability and the provider's Fusion presentation signal. */
function hasFusionStandardTier(data: unknown): boolean {
	if (!data || typeof data !== "object") return false;
	const tiers = (data as { auto?: { tiers?: unknown } }).auto?.tiers;
	if (!Array.isArray(tiers)) return false;
	const visible = (tier: any) => {
		const status = tier?.status;
		return status && typeof status === "object" && !Array.isArray(status)
			&& (status.tier_picker_enabled === undefined || status.tier_picker_enabled === true);
	};
	// VS Code presents Auto as Fusion when it has a picker-visible Fusion tier,
	// even if that tier itself is disabled. Balance alone also appears in classic
	// Auto metadata, so it cannot establish Fusion presentation by itself.
	return tiers.some((tier) => tier && typeof tier === "object" && visible(tier)
		&& tier.id === "balance" && tier.type === "auto" && tier.status.enabled === true)
		&& tiers.some((tier) => tier && typeof tier === "object" && visible(tier)
			&& tier.type === "fusion" && typeof tier.status.enabled === "boolean");
}

// A startup snapshot only: /reload (or restart) discovers entitlement changes.
let fusionStandardAvailable = false;

async function discoverFusionStandard(): Promise<boolean> {
	try {
		const auth = await ensureToken();
		if (!auth) return false;
		const res = await fetch(`${auth.baseUrl}/meta`, {
			method: "GET",
			headers: { ...capiHeaders(auth.token), Accept: "application/json", "X-GitHub-Api-Version": COPILOT_META_API_VERSION },
			signal: AbortSignal.timeout(AUTO_TIMEOUT_MS),
		});
		if (!res.ok) {
			// Never log authenticated response bodies or credentials.
			log(`Fusion Standard metadata unavailable: HTTP ${res.status}`);
			return false;
		}
		const enabled = hasFusionStandardTier(await res.json());
		log(`Fusion Standard metadata: available=${enabled}`);
		return enabled;
	} catch {
		// Fail closed for Fusion, without breaking classic Auto or extension loading.
		log("Fusion Standard metadata unavailable (request or parsing failed)");
		return false;
	}
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

/**
 * Server-provided multi-turn controls (`multi_turn_mode: "model_cards"`) that
 * make a Fusion anchor eligible for native-style drift checks on later turns.
 * Semantics inferred from native Copilot CLI traces (see README): skip window
 * growth (`initial_skip`, `backoff_coefficient`, `max_skip`, `anchor_skip`), the
 * drift-prompt window (`context_window`) and capability escalation (`sigma`,
 * `escalate_threshold`).
 */
type DriftControls = {
	initialSkip: number;
	contextWindow: number;
	backoff: number;
	maxSkip: number;
	anchorSkip: number;
	escalateThreshold: number;
	sigma: Record<string, number>;
};

/** Native drift prompts truncate each user message to this many characters. */
const DRIFT_MESSAGE_MAX_CHARS = 1022;

const HYDRA_SCORE_KEYS = ["code_gen", "debugging", "reasoning", "tool_use"] as const;

type AutoDecision = {
	sessionToken: string;
	selectedModel: AutoSelectedModel;
	expiresAtMs: number;
	hydraScores?: Record<string, number>;
	/** Fusion only: present when the router offered model-cards drift checking. */
	driftControls?: DriftControls;
};

function parseDriftControls(data: Record<string, unknown>): DriftControls | undefined {
	const rl = data.hydra_rl_multi_turn;
	if (rl && typeof rl === "object" && Object.keys(rl).length) {
		// Server-driven RL multi-turn state (state_token/skip_turns) was never
		// observed; its request echo is unknown. Never log or act on it.
		log("auto: server-driven multi-turn state present; unsupported, anchoring each turn");
		return undefined;
	}
	if (data.multi_turn_mode !== "model_cards") return undefined;
	const mt = data.multi_turn as Record<string, unknown> | undefined;
	if (!mt || typeof mt !== "object" || mt.enabled !== true) return undefined;
	const scores = data.hydra_scores as Record<string, unknown> | undefined;
	if (!scores || typeof scores !== "object" || Object.keys(scores).length !== HYDRA_SCORE_KEYS.length) return undefined;
	if (HYDRA_SCORE_KEYS.some((k) => typeof scores[k] !== "number" || !Number.isFinite(scores[k]))) return undefined;
	const initialSkip = mt.initial_skip;
	const contextWindow = mt.context_window;
	const backoff = mt.backoff_coefficient;
	const maxSkip = mt.max_skip;
	const anchorSkip = mt.anchor_skip ?? 0;
	const escalateThreshold = mt.escalate_threshold;
	const sigma = mt.sigma as Record<string, unknown> | undefined;
	const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
	if (!int(initialSkip, 0, 64) || !int(contextWindow, 1, 50) || !int(maxSkip, 0, 256)) return undefined;
	// Only observed values are interpreted: anchor_skip 0 and an integer backoff.
	if (anchorSkip !== 0 || !int(backoff, 1, 8)) return undefined;
	if (!int(escalateThreshold, 1, HYDRA_SCORE_KEYS.length)) return undefined;
	if (!sigma || typeof sigma !== "object") return undefined;
	if (HYDRA_SCORE_KEYS.some((k) => typeof sigma[k] !== "number" || !Number.isFinite(sigma[k]) || (sigma[k] as number) < 0)) return undefined;
	return {
		initialSkip: initialSkip as number,
		contextWindow: contextWindow as number,
		backoff: backoff as number,
		maxSkip: maxSkip as number,
		anchorSkip: anchorSkip as number,
		escalateThreshold: escalateThreshold as number,
		sigma: Object.fromEntries(HYDRA_SCORE_KEYS.map((k) => [k, sigma[k] as number])),
	};
}

/**
 * Native escalation rule: adopt the drift route when at least
 * `escalate_threshold` capability dimensions rose above the anchor's by more
 * than `sigma`. Lower requirements never switch (the route is sticky).
 */
function shouldEscalate(anchor: AutoDecision, drift: AutoDecision): boolean {
	const controls = anchor.driftControls;
	const caps = anchor.hydraScores;
	const scores = drift.hydraScores;
	if (!controls || !caps || !scores) return false;
	const rose = HYDRA_SCORE_KEYS.filter((k) => typeof scores[k] === "number" && Number.isFinite(scores[k])
		&& scores[k] - caps[k] > controls.sigma[k]).length;
	return rose >= controls.escalateThreshold;
}

/**
 * Single-call AutoV2 router. Routes the prompt to a concrete model and mints the
 * session token the chat request bills against — all in one round-trip.
 */
async function fetchAutoDecision(
	baseUrl: string,
	token: string,
	prompt: string,
	opts: { tier: AutoModeTier; hasImage?: boolean; fusion?: boolean; multiTurn?: Record<string, unknown> },
): Promise<AutoDecision | undefined> {
	const body: Record<string, unknown> = { prompt };
	// `fast` is a server default; only send an explicit tier for the rest so the
	// server can fall back to its own default if a tier is ever retired.
	if (opts.tier) body.tier = opts.tier;
	if (opts.fusion || opts.hasImage) body.has_image = !!opts.hasImage;
	if (opts.fusion) {
		body.fusion = true;
		body.hydra_rl_multi_turn = {};
		if (opts.multiTurn) body.multi_turn = opts.multiTurn;
	}

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
		// Status only: authenticated response bodies are never logged.
		log(`auto fetch non-ok: ${res?.status}`);
		return undefined;
	}
	const data = (await res.json().catch(() => undefined)) as
		| { session_token?: string; selected_model?: AutoSelectedModel; expires_at?: number; hydra_scores?: Record<string, number>; [key: string]: unknown }
		| undefined;
	if (!data || typeof data.session_token !== "string" || !data.session_token.trim() || !data.selected_model?.id) {
		// Do not log the payload: even a malformed response can contain a token.
		log("auto response missing session_token or selected_model");
		return undefined;
	}
	const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : NaN;
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + SESSION_REFRESH_SKEW_MS) {
		log("auto response missing valid session expiry");
		return undefined;
	}
	const intent = opts.multiTurn?.routing_intent;
	log(
		`auto: tier=${opts.tier}${typeof intent === "string" ? ` intent=${intent}` : ""} selected=${data.selected_model.id} scores=${JSON.stringify(data.hydra_scores ?? {})} expires=${new Date(expiresAtMs).toISOString()}`,
	);
	return {
		sessionToken: data.session_token,
		selectedModel: data.selected_model,
		expiresAtMs,
		hydraScores: data.hydra_scores,
		...(opts.fusion ? { driftControls: parseDriftControls(data) } : {}),
	};
}

// ---------------------------------------------------------------------------
// Model catalog + routing selection
// ---------------------------------------------------------------------------

const catalog = new Map<string, Model<Api>>();
for (const m of getModels(SOURCE_PROVIDER) as Model<Api>[]) catalog.set(m.id, m);

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

// ---------------------------------------------------------------------------
// Per-conversation routing + session state (keyed by options.sessionId)
// ---------------------------------------------------------------------------

type ConvState = {
	/** The routed decision, cached for the life of the conversation (24h token) for classic Auto. */
	decision?: AutoDecision;
	decisionInflight?: Promise<AutoDecision | undefined>;
	/** Tier and mode associated with the cached decision. */
	routedTier?: AutoModeTier;
	routedFusion?: boolean;
	/** Fusion Standard reuses one route during pi tool continuations for the current user turn. */
	routedTurnKey?: string;
	/** Fusion Standard multi-turn cadence for the current anchor route. */
	fusion?: FusionCadence;
};

/**
 * Native-style drift-check cadence (inferred from Copilot CLI traces):
 * after an anchor the first check is at `anchor_skip + 1` turns; each kept check
 * skips `window` turns and multiplies the window by `backoff_coefficient` (up to
 * `max_skip`); compaction forces a check on the next turn.
 */
type FusionCadence = {
	/** Real user turns since the current anchor route. */
	turnsSinceAnchor: number;
	/** `current_skip_window` sent with the next check. */
	window: number;
	/** Value of `turnsSinceAnchor` at which the next drift check happens. */
	nextCheckAt: number;
	/** Compaction happened: check on the next real user turn. */
	forceCheck: boolean;
	/** First real user turn included in drift prompts (after an escalation). */
	historyStartKey?: string;
	/** The next check confirms an escalation and then restarts the history. */
	historyResetPending: boolean;
};

function anchorCadence(decision: AutoDecision, escalated = false, prior?: FusionCadence): FusionCadence {
	const controls = decision.driftControls;
	return {
		turnsSinceAnchor: 0,
		window: Math.min(controls?.initialSkip ?? 0, controls?.maxSkip ?? 0),
		nextCheckAt: (controls?.anchorSkip ?? 0) + 1,
		forceCheck: false,
		historyStartKey: escalated ? prior?.historyStartKey : undefined,
		historyResetPending: escalated,
	};
}

const conversations = new Map<string, ConvState>();

/**
 * Real user messages per pi session, captured from the `context` event, where
 * pi still distinguishes typed user input from custom/bash/summary messages that
 * `convertToLlm` later maps to `role: "user"`. Memory only; never logged.
 */
const realUserTurns = new Map<string, Set<string>>();

/**
 * Ordered log of real user messages per session, kept across compaction (which
 * drops older messages from the context) so drift prompts can still include
 * them, as the native client does. Memory only; capped; never logged.
 */
const realUserLog = new Map<string, { key: string; text: string }[]>();
const USER_LOG_MAX = 64;

function recordUserLog(sessionId: string, entries: { key: string; text: string }[]): void {
	const log = realUserLog.get(sessionId) ?? [];
	const known = new Set(log.map((e) => e.key));
	for (const e of entries) if (!known.has(e.key)) log.push(e);
	realUserLog.set(sessionId, log.slice(-USER_LOG_MAX));
}

function userTurnId(timestamp: number, text: string): string {
	return `${timestamp}\u0000${text}`;
}

/** Router prompt cap for auxiliary/ephemeral requests such as summarization. */
const AUX_PROMPT_MAX_CHARS = 16_000;

function getConv(key: string): ConvState {
	let c = conversations.get(key);
	if (!c) {
		c = {};
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

type UserTurn = {
	/** In-memory identity of the current user turn (timestamp + text). */
	key: string;
	/** Text of the latest real user message. */
	prompt: string;
	/** Real user messages, oldest first (in-memory identity + text). */
	entries: { key: string; text: string }[];
	/**
	 * True when pi supplied real-user identities but none appear in this context,
	 * e.g. compaction summarization calling the session model. Such requests must
	 * not advance Fusion's turn state.
	 */
	auxiliary: boolean;
	/** True when real-user identities from pi's `context` event were applied. */
	identified: boolean;
};

function messageText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content.trim();
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
}

function resolveUserTurn(context: Context, sessionId: string | undefined): UserTurn {
	const users = context.messages
		.filter((m) => m.role === "user")
		.map((m) => ({ timestamp: m.timestamp, text: messageText(m.content as never) }));
	const real = sessionId ? realUserTurns.get(sessionId) : undefined;
	let turns = users;
	let auxiliary = false;
	if (real) {
		const matched = users.filter((u) => real.has(userTurnId(u.timestamp, u.text)));
		if (matched.length) turns = matched;
		else if (users.length) auxiliary = true;
	}
	const last = turns.at(-1);
	const key = last ? userTurnId(last.timestamp, last.text) : "";
	const identified = !!real && !auxiliary;
	const contextEntries = turns.map((u) => ({ key: userTurnId(u.timestamp, u.text), text: u.text }));
	// Prefer the session log (survives compaction) when it reaches the current turn.
	const logged = identified && sessionId ? realUserLog.get(sessionId) : undefined;
	const at = logged ? logged.findIndex((e) => e.key === key) : -1;
	return {
		key,
		prompt: last?.text ?? "",
		entries: logged && at >= 0 ? logged.slice(0, at + 1) : contextEntries,
		auxiliary,
		identified,
	};
}

const FUSION_TIER: AutoModeTier = "balance";
const ANCHOR_INTENT = { routing_intent: "anchor", turns_since_anchor: 0 } as const;

/**
 * Drift-check prompt as observed natively: the last `context_window + 1` real
 * user messages (from the history start), each truncated, joined by a blank line.
 */
function driftPrompt(turn: UserTurn, controls: DriftControls, historyStartKey: string | undefined): string {
	const start = historyStartKey ? turn.entries.findIndex((e) => e.key === historyStartKey) : -1;
	return turn.entries
		.slice(Math.max(start, 0))
		.map((e) => e.text)
		.filter(Boolean)
		.slice(-(controls.contextWindow + 1))
		.map((t) => t.slice(0, DRIFT_MESSAGE_MAX_CHARS))
		.join("\n\n");
}

/**
 * Routes a new Fusion Standard user turn following the native multi-turn cadence:
 * an anchor route, skipped turns (no `/auto`) inside the skip window, and
 * `drift_check` requests that keep the anchor's model and token unless the
 * capability scores escalate, in which case the drift route is adopted.
 */
async function routeFusionTurn(
	conv: ConvState,
	baseUrl: string,
	token: string,
	turn: UserTurn,
	hasImage: boolean,
): Promise<{ decision: AutoDecision; cadence: FusionCadence } | undefined> {
	const anchor = conv.decision;
	const prior = conv.fusion;
	const anchorUsable = anchor && prior && conv.routedFusion && conv.routedTier === FUSION_TIER && turn.identified
		&& Date.now() < anchor.expiresAtMs - SESSION_REFRESH_SKEW_MS && anchor.driftControls && anchor.hydraScores;
	if (anchorUsable) {
		const controls = anchor.driftControls!;
		const since = prior.turnsSinceAnchor + 1;
		if (!prior.forceCheck && since < prior.nextCheckAt) {
			log(`fusion: turn ${since} since anchor inside skip window; reusing ${anchor.selectedModel.id}`);
			return { decision: anchor, cadence: { ...prior, turnsSinceAnchor: since } };
		}
		const drift = await fetchAutoDecision(baseUrl, token, driftPrompt(turn, controls, prior.historyStartKey), {
			tier: FUSION_TIER,
			hasImage,
			fusion: true,
			multiTurn: {
				routing_intent: "drift_check",
				turns_since_anchor: since,
				current_skip_window: prior.window,
				anchor_cap_vector: { ...anchor.hydraScores },
			},
		});
		const historyStartKey = prior.historyResetPending ? turn.key : prior.historyStartKey;
		if (!drift) {
			// Unknown natively; retry on the next turn while the anchor stays valid.
			log("fusion: drift check failed; continuing on the unexpired anchor");
			return { decision: anchor, cadence: { ...prior, turnsSinceAnchor: since, nextCheckAt: since + 1 } };
		}
		if (shouldEscalate(anchor, drift)) {
			log(`fusion: drift check escalated ${anchor.selectedModel.id} -> ${drift.selectedModel.id}`);
			return { decision: drift, cadence: anchorCadence(drift, true, { ...prior, historyStartKey }) };
		}
		log(`fusion: drift check kept ${anchor.selectedModel.id} (router suggested ${drift.selectedModel.id})`);
		return {
			decision: anchor,
			cadence: {
				turnsSinceAnchor: since,
				window: Math.min(prior.window * controls.backoff, controls.maxSkip),
				nextCheckAt: since + prior.window + 1,
				forceCheck: false,
				historyStartKey,
				historyResetPending: false,
			},
		};
	}
	const fresh = await fetchAutoDecision(baseUrl, token, turn.prompt, {
		tier: FUSION_TIER, hasImage, fusion: true, multiTurn: { ...ANCHOR_INTENT },
	});
	return fresh ? { decision: fresh, cadence: anchorCadence(fresh) } : undefined;
}

/**
 * Routes the conversation through `POST /auto`. Classic Auto caches the decision
 * for the life of the session token and re-routes when the tier changes or the
 * token nears expiry. Fusion Standard routes new real user turns with the
 * native multi-turn cadence (anchor, skipped turns, drift checks) and reuses the
 * route for the turn's tool continuations.
 */
async function ensureDecision(
	conv: ConvState,
	baseUrl: string,
	token: string,
	turn: UserTurn,
	tier: AutoModeTier,
	hasImage: boolean,
	fusion: boolean,
): Promise<AutoDecision | undefined> {
	const fresh = conv.decision && Date.now() < conv.decision.expiresAtMs - SESSION_REFRESH_SKEW_MS;
	const sameRoute = conv.routedTier === tier && conv.routedFusion === fusion && (!fusion || conv.routedTurnKey === turn.key);
	if (fresh && sameRoute) return conv.decision;
	if (conv.decisionInflight) {
		await conv.decisionInflight;
		// A concurrent caller might have routed another tier; check again.
		return ensureDecision(conv, baseUrl, token, turn, tier, hasImage, fusion);
	}

	conv.decisionInflight = (async () => {
		if (fusion) {
			const routed = await routeFusionTurn(conv, baseUrl, token, turn, hasImage);
			if (!routed) return undefined;
			conv.decision = routed.decision;
			conv.fusion = routed.cadence;
		} else {
			const d = await fetchAutoDecision(baseUrl, token, turn.prompt, { tier, hasImage });
			// Never reuse an expired or differently-tiered token when re-routing fails.
			if (!d) return undefined;
			conv.decision = d;
			conv.fusion = undefined;
		}
		conv.routedTier = tier;
		conv.routedFusion = fusion;
		conv.routedTurnKey = turn.key;
		return conv.decision;
	})().finally(() => {
		conv.decisionInflight = undefined;
	});
	return conv.decisionInflight;
}

// ---------------------------------------------------------------------------
// UI surface (route shown as a transient toast + footer status)
// ---------------------------------------------------------------------------

let uiNotify: ((msg: string, variant: "info" | "success" | "warning" | "error") => void) | undefined;
let uiStatus: ((key: string, text: string) => void) | undefined;

function announce(modelId: string, tier: AutoModeTier, fusion = false): void {
	if (fusion) {
		uiNotify?.(`Copilot Fusion Standard → ${modelId}`, "info");
		uiStatus?.("copilot-fusion", `fusion:standard → ${modelId}`);
		return;
	}
	uiNotify?.(`Auto (${tier}) → ${modelId}`, tier === "intelligence" ? "success" : "info");
	uiStatus?.("copilot-auto", `auto:${tier} → ${modelId}`);
}

// ---------------------------------------------------------------------------
// streamSimple: route, then delegate to the target model's native stream
// ---------------------------------------------------------------------------

function errorStream(message: string, providerId = PROVIDER_ID, modelId = MODEL_ID): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: providerId as Api,
			provider: providerId,
			model: modelId,
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
	fusion = false,
): AssistantMessageEventStream {
	// Merge case-insensitively so callers/catalog entries cannot accidentally
	// append a second session token with different casing. Apply the same client
	// identity to known AND synthesized models, not just the router request.
	const headers = new Headers(target.headers);
	for (const [key, value] of Object.entries(options?.headers ?? {})) headers.set(key, value);
	for (const [key, value] of Object.entries(COPILOT_BASE_HEADERS)) headers.set(key, value);
	headers.set("X-GitHub-Api-Version", COPILOT_API_VERSION);
	headers.set("VScode-SessionId", VSCODE_SESSION_ID);
	headers.set("VScode-MachineId", VSCODE_MACHINE_ID);
	headers.set("Editor-Device-Id", VSCODE_DEVICE_ID);
	headers.set("Copilot-Session-Token", sessionToken);
	headers.set("Authorization", `Bearer ${token}`);
	// Match VS Code's chat network correlation headers. These are client-generated
	// request IDs; no secret or persisted VS Code state is implied.
	const requestId = randomUUID();
	headers.set("X-Request-Id", requestId);
	headers.set("X-Agent-Task-Id", requestId);
	headers.set("X-Interaction-Type", "conversation");
	headers.set("OpenAI-Intent", "conversation-edits");
	// All catalog headers are now in options; avoid duplicate case variants when
	// the provider merges model.headers again. Keep provider/id concrete on wire.
	target = { ...target, headers: undefined };
	context = fusion ? restoreFusionContext(context) : restoreAutoContext(context);
	const innerOptions: SimpleStreamOptions = { ...options, apiKey: token, headers: Object.fromEntries(headers) };
	log(`delegate: model=${target.id} api=${target.api} autoSessionToken=present`);

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

/** Maps a model id (`auto`, `auto-intelligence`, …) to a routing tier. */
function tierForModelId(modelId: string): AutoModeTier {
	if (modelId === MODEL_ID) return defaultTier;
	const suffix = modelId.startsWith(`${MODEL_ID}-`) ? modelId.slice(MODEL_ID.length + 1) : "";
	return normalizeTier(suffix) ?? defaultTier;
}

function streamRouted(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, fusion: boolean): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const providerId = fusion ? FUSION_PROVIDER_ID : PROVIDER_ID;
	const routedModelId = fusion ? FUSION_MODEL_ID : model.id;
	const push = (event: Parameters<typeof asAutoEvent>[0]) => out.push(fusion ? asFusionEvent(event, model) : asAutoEvent(event, model));
	const fail = async (message: string) => {
		for await (const event of errorStream(message, providerId, routedModelId)) push(event);
	};

	(async () => {
		try {
			if (fusion && !fusionStandardAvailable) {
				await fail("Copilot Fusion Standard is unavailable: /meta did not confirm an enabled, picker-visible Standard tier. Run /reload after login or entitlement changes.");
				out.end();
				return;
			}
			const auth = await ensureToken();
			if (!auth) {
				await fail("GitHub Copilot not authenticated. Run /login and select GitHub Copilot.");
				out.end();
				return;
			}

			const convKey = options?.sessionId;
			// With pi's context event active, a session id that never produced one is a
			// throwaway (pi's summarizers use a fresh id): route it without retaining
			// state, announcing it, or sending an unbounded transcript to the router.
			const ephemeral = !!convKey && realUserTurns.size > 0 && !realUserTurns.has(convKey);
			// Unkeyed calls must not share another conversation's route/token.
			const conv: ConvState = convKey && !ephemeral ? getConv(convKey) : {};
			const tier = fusion ? FUSION_TIER : tierForModelId(model.id);
			const turn = resolveUserTurn(context, convKey);
			const previousDecision = conv.decision;
			const prompt = ephemeral || turn.auxiliary ? turn.prompt.slice(-AUX_PROMPT_MAX_CHARS) : turn.prompt;
			const hasImage = hasImageInput(context);
			const fresh = conv.decision && Date.now() < conv.decision.expiresAtMs - SESSION_REFRESH_SKEW_MS;
			const sameMode = fresh && conv.routedTier === tier && conv.routedFusion === fusion;
			// Auxiliary Fusion requests (e.g. compaction summarization) may reuse the
			// current route but never advance the per-turn routing state; a turn with no
			// text (e.g. image-only) also stays on the current Fusion route.
			const compatible = sameMode && (!fusion || turn.auxiliary || !prompt || conv.routedTurnKey === turn.key);
			if (!prompt && !compatible) {
				await fail(fusion ? "Copilot Fusion Standard needs a prompt to route a request." : "Auto mode needs a prompt to route a request.");
				out.end();
				return;
			}

			let decision: AutoDecision | undefined;
			if (fusion && (turn.auxiliary || ephemeral)) {
				decision = compatible
					? conv.decision
					: await fetchAutoDecision(auth.baseUrl, auth.token, prompt, { tier, hasImage, fusion: true, multiTurn: { ...ANCHOR_INTENT } });
			} else if (prompt && !(fusion && compatible)) {
				decision = await ensureDecision(conv, auth.baseUrl, auth.token, { ...turn, prompt }, tier, hasImage, fusion);
			} else {
				decision = conv.decision;
			}
			if (!decision) {
				await fail(fusion
					? "Failed to route GitHub Copilot Fusion Standard (POST /auto)."
					: "Failed to route a GitHub Copilot auto model (POST /auto)."
				);
				out.end();
				return;
			}

			// Resolve this request from its own decision, not mutable shared state.
			const target = resolveTargetModel(decision.selectedModel, auth.baseUrl);
			if (decision !== previousDecision && !ephemeral && !turn.auxiliary) {
				announce(target.id, tier, fusion);
				log(`routed ${convKey ?? "unkeyed"} -> ${target.id} (tier=${tier}, fusion=${fusion})`);
			}

			// /auto supplies one selected model, not an eligible fallback pool. Do not
			// assume its token works for arbitrary catalog models or retry without it.
			const inner = delegateStream(target, context, options, auth.token, decision.sessionToken, fusion);
			for await (const event of inner) push(event);
			out.end();
		} catch (e) {
			await fail(e instanceof Error ? e.message : String(e));
			out.end();
		}
	})();

	return out;
}

function streamAuto(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return streamRouted(model, context, options, false);
}

function streamFusionStandard(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return streamRouted(model, context, options, true);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI): Promise<void> {
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
			// Bare `auto` follows the configured default tier (balance unless set).
			autoModel(MODEL_ID, `Auto (${defaultTier})`),
			// One entry per pickable tier so users choose via `/model`.
			...SELECTABLE_TIERS.map((t) => autoModel(`${MODEL_ID}-${t}`, `Auto (${t})`)),
		],
	});

	// Async factory discovery completes before startup/model selection (including
	// --list-models and resume). Do not advertise an unverified entitlement.
	fusionStandardAvailable = await discoverFusionStandard();
	if (fusionStandardAvailable) {
		pi.registerProvider(FUSION_PROVIDER_ID, {
			name: "GitHub Copilot Fusion",
			baseUrl: "https://api.individual.githubcopilot.com",
			apiKey: "copilot-fusion",
			api: "openai-completions",
			streamSimple: streamFusionStandard as never,
			models: [autoModel(FUSION_MODEL_ID, "Standard")],
		});
	}

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

	// Reset sticky routing only for the compacted conversation. Fusion keeps its
	// anchor, as the native client does, and checks for drift on the next turn.
	pi.on("session_compact", async (event, ctx) => {
		capture(ctx as never);
		const key = compactedSessionKey(event) ?? ctx.sessionManager.getSessionId();
		if (key) {
			const conv = conversations.get(key);
			if (conv?.routedFusion) {
				// Native keeps the anchor and forces a drift check on the next turn.
				if (conv.fusion) conv.fusion = { ...conv.fusion, forceCheck: true };
				log(`fusion anchor retained across compaction for session ${key}; next turn is drift-checked`);
				return;
			}
			conversations.delete(key);
			log(`routing cache cleared for compacted session ${key}`);
			return;
		}
		// Fallback for unknown payload shapes.
		conversations.clear();
		log("routing cache cleared (compaction fallback: unknown session key)");
	});

	// Record which context messages are real typed user input (memory only), and
	// keep a short log of them so drift prompts survive compaction like natively.
	pi.on("context", async (event, ctx) => {
		const key = ctx.sessionManager.getSessionId();
		if (!key) return;
		const entries = event.messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const text = messageText((m as unknown as { content: never }).content);
				return { key: userTurnId(m.timestamp, text), text };
			});
		realUserTurns.set(key, new Set(entries.map((e) => e.key)));
		recordUserLog(key, entries);
	});

	// A tree navigation changes the conversation the anchor was chosen for.
	pi.on("session_tree", async (_event, ctx) => {
		const key = ctx.sessionManager.getSessionId();
		if (key) realUserLog.delete(key);
		if (key && conversations.get(key)?.routedFusion) {
			conversations.delete(key);
			log(`fusion route cleared after tree navigation in session ${key}`);
		}
	});
}
