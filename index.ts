/**
 * GitHub Copilot Auto model for pi
 * ================================
 *
 * Adds a `github-copilot-auto/auto` model that follows GitHub Copilot's own
 * server-side auto model selection — including the per-turn **intent router**
 * that VS Code uses (`POST /models/session` + `POST /models/session/intent`).
 *
 * Port of https://github.com/m0wer/opencode-github-copilot-auto-model to pi.
 *
 * Why this works better on pi than on opencode:
 *   - pi's built-in GitHub Copilot provider already authenticates as
 *     `Copilot-Integration-Id: vscode-chat` using VS Code's GitHub App client ID.
 *     That is the first-party gate the intent router checks, so the router
 *     returns real ML routing decisions (opencode's client ID gets a 404).
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

const COPILOT_API_VERSION = "2026-06-01";
const INTENT_TIMEOUT_MS = 2000;
const SESSION_REFRESH_SKEW_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

// Identity headers VS Code stamps on the gated auto-mode CAPI calls. pi already
// sends Copilot-Integration-Id: vscode-chat (the gate); these add the rest.
const COPILOT_BASE_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
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

type AutoSession = {
	sessionToken: string;
	availableModels: string[];
	selectedModel?: string;
	expiresAtMs: number;
};

type RouterDecision = {
	predicted_label?: "needs_reasoning" | "no_reasoning";
	confidence?: number;
	chosen_model?: string;
	candidate_models?: string[];
	reasoning_bucket?: string;
};

async function fetchAutoSession(baseUrl: string, token: string): Promise<AutoSession | undefined> {
	const res = await fetch(`${baseUrl}/models/session`, {
		method: "POST",
		headers: capiHeaders(token),
		body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
	}).catch((e) => {
		log(`session fetch failed: ${String(e)}`);
		return undefined;
	});
	if (!res || !res.ok) {
		log(`session fetch non-ok: ${res?.status} ${res ? await res.text().catch(() => "") : ""}`);
		return undefined;
	}
	const data = (await res.json().catch(() => undefined)) as
		| { session_token?: string; available_models?: unknown; selected_model?: unknown; expires_at?: number }
		| undefined;
	if (!data || typeof data.session_token !== "string") return undefined;
	const availableModels = Array.isArray(data.available_models)
		? (data.available_models.filter((m) => typeof m === "string") as string[])
		: [];
	const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 30 * 60_000;
	log(`session: available=[${availableModels.join(", ")}] selected=${String(data.selected_model)}`);
	return {
		sessionToken: data.session_token,
		availableModels,
		selectedModel: typeof data.selected_model === "string" ? data.selected_model : undefined,
		expiresAtMs,
	};
}

async function fetchIntent(
	baseUrl: string,
	token: string,
	session: AutoSession,
	prompt: string,
	context: Record<string, unknown>,
): Promise<RouterDecision | undefined> {
	const body = { prompt, available_models: session.availableModels, ...context };
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), INTENT_TIMEOUT_MS);
	try {
		const res = await fetch(`${baseUrl}/models/session/intent`, {
			method: "POST",
			headers: capiHeaders(token, session.sessionToken),
			body: JSON.stringify(body),
			signal: ac.signal,
		});
		if (!res.ok) {
			log(`intent non-ok: ${res.status} ${await res.text().catch(() => "")}`);
			return undefined;
		}
		const data = (await res.json().catch(() => undefined)) as RouterDecision | undefined;
		log(`intent: ${JSON.stringify(data)}`);
		return data;
	} catch (e) {
		log(`intent failed: ${String(e)}`);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
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

function routablePool(session: AutoSession): string[] {
	return session.availableModels.filter((id) => catalog.has(id));
}

/** Pure auto mode: trust Copilot router/session, no local preference override. */
function selectModel(decision: RouterDecision | undefined, session: AutoSession): { id: string; label?: string; candidates: string[] } | undefined {
	const pool = routablePool(session);
	if (!pool.length) return undefined;

	const label = decision?.predicted_label;
	const candidates = (decision?.candidate_models ?? []).filter((id) => pool.includes(id));
	const chosen =
		(decision?.chosen_model && pool.includes(decision.chosen_model) ? decision.chosen_model : undefined) ??
		candidates[0] ??
		(session.selectedModel && pool.includes(session.selectedModel) ? session.selectedModel : undefined) ??
		pool[0];

	return { id: chosen, label, candidates };
}

function buildAttemptOrder(primaryId: string, extraCandidates: string[] | undefined, session: AutoSession): string[] {
	const pool = routablePool(session);
	return dedupe([primaryId, ...(extraCandidates ?? []), ...(session.selectedModel ? [session.selectedModel] : []), ...pool]);
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
	session?: AutoSession;
	sessionInflight?: Promise<AutoSession | undefined>;
	routedModelId?: string;
	routedLabel?: string;
	routedCandidates?: string[];
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

async function ensureSession(conv: ConvState, baseUrl: string, token: string): Promise<AutoSession | undefined> {
	if (conv.session && Date.now() < conv.session.expiresAtMs - SESSION_REFRESH_SKEW_MS) return conv.session;
	if (!conv.sessionInflight) {
		conv.sessionInflight = fetchAutoSession(baseUrl, token)
			.then((s) => {
				if (s) conv.session = s;
				return conv.session;
			})
			.finally(() => {
				conv.sessionInflight = undefined;
			});
	}
	return conv.sessionInflight;
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

function announce(modelId: string, label?: string): void {
	const suffix = label ? ` · ${label}` : "";
	uiNotify?.(`Auto → ${modelId}${suffix}`, label === "needs_reasoning" ? "success" : "info");
	uiStatus?.("copilot-auto", `auto → ${modelId}`);
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

function streamAuto(_model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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

			const session = await ensureSession(conv, auth.baseUrl, auth.token);
			if (!session) {
				for await (const e of errorStream("Failed to open GitHub Copilot auto session.")) out.push(e);
				out.end();
				return;
			}

			// Sticky routing: route once on the first turn of a conversation, then
			// reuse it (KV-cache stability, like VS Code). Re-evaluate after compaction
			// (assistant turn count drops back toward 0).
			const assistantTurns = countAssistantTurns(context);
			let chosenId = conv.routedModelId;
			let label = conv.routedLabel;

			if (!chosenId || assistantTurns === 0) {
				const prompt = lastUserPrompt(context);
				let decision: RouterDecision | undefined;
				if (prompt) {
					decision = await fetchIntent(auth.baseUrl, auth.token, session, prompt, {
						session_id: convKey,
						turn_number: conv.turn + 1,
						prompt_char_count: prompt.length,
					});
				}
				const picked = selectModel(decision, session);
				if (!picked) {
					for await (const e of errorStream("No routable GitHub Copilot models in the auto pool.")) out.push(e);
					out.end();
					return;
				}
				chosenId = picked.id;
				label = picked.label;
				conv.routedModelId = chosenId;
				conv.routedLabel = label;
				conv.routedCandidates = picked.candidates;
				announce(chosenId, label);
				log(`routed ${convKey} -> ${chosenId} (label=${label ?? "n/a"})`);
			}

			conv.turn += 1;
			const attempts = buildAttemptOrder(chosenId, conv.routedCandidates, session);
			let lastErrorEvent: { type: "error"; error?: { errorMessage?: string } } | undefined;

			for (let i = 0; i < attempts.length; i++) {
				const attemptId = attempts[i];
				const base = catalog.get(attemptId);
				if (!base) continue;

				// Delegate to the routed model's own endpoint family, on the Copilot host.
				const target: Model<Api> = { ...base, provider: SOURCE_PROVIDER, baseUrl: auth.baseUrl };
				const inner = delegateStream(target, context, options, auth.token, session.sessionToken);

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
					const hasAnother = i < attempts.length - 1;
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

				if (attemptId !== chosenId) {
					conv.routedModelId = attemptId;
					announce(attemptId, label);
					log(`fallback promoted ${chosenId} -> ${attemptId}`);
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
	pi.registerProvider(PROVIDER_ID, {
		name: "GitHub Copilot (Auto)",
		baseUrl: "https://api.individual.githubcopilot.com",
		// Auth is resolved internally from the existing github-copilot login; this
		// literal keeps pi from treating the provider as unconfigured.
		apiKey: "copilot-auto",
		api: "openai-completions",
		streamSimple: streamAuto as never,
		models: [
			{
				id: MODEL_ID,
				name: "Auto",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.contextWindow ?? 200000,
				maxTokens: config.maxTokens ?? 64000,
			},
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
