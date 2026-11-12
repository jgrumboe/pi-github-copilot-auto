import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModels, type Api, type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asAutoEvent, asFusionEvent, restoreAutoContext, restoreFusionContext } from "../auto-identity.js";

// Never read the developer's credentials/config or call a real Copilot endpoint.
vi.mock("node:os", async (original) => ({
	...await original<typeof import("node:os")>(),
	homedir: () => "/nonexistent-copilot-auto-test-home",
}));
vi.mock("node:fs/promises", async (original) => ({
	...await original<typeof import("node:fs/promises")>(),
	readFile: vi.fn(async () => JSON.stringify({
		"github-copilot": { access: "test-access-token", expires: Date.now() + 3600000 },
	})),
}));

type Stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
const prompt: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: zeroCost };
const baseUrl = "https://api.individual.githubcopilot.com";
let selectedId: string;
let autoResponse: Record<string, unknown> | undefined;
/** Per-/auto-request override merged into the default response (n is 1-based). */
let autoHook: ((body: Record<string, any>, n: number) => Record<string, unknown> | undefined) | undefined;
let routeStatus: number;
let chatStatus: number;
let metaResponse: unknown;
let metaStatus: number;
let metaFailure: "network" | "json" | "timeout" | undefined;
let metaRequests: { url: string; headers: Headers; method: string | undefined; body: RequestInit["body"] }[];
let fetchMock: ReturnType<typeof vi.fn>;
let requests: { url: string; headers: Headers; body: Record<string, any> }[];
let tempDirs: string[] = [];

function nativeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: "openai-completions", provider: "github-copilot", model: "mai-code-1.1-flash",
		content: [{ type: "text", text: "Hello" }], usage, stopReason: "stop", timestamp: 2, ...overrides };
}

async function loadExtension() {
	const { default: extension } = await import("../index.js");
	const registrations = new Map<string, { streamSimple: Stream; models: Model<Api>[] }>();
	const handlers = new Map<string, Function>();
	await extension({
		registerProvider: (id: string, config: { streamSimple: Stream; models: Model<Api>[] }) => { registrations.set(id, config); },
		on: (name: string, fn: Function) => handlers.set(name, fn),
	} as unknown as ExtensionAPI);
	const auto = registrations.get("github-copilot-auto")!;
	const fusion = registrations.get("github-copilot-fusion")!;
	return {
		models: auto.models,
		fusionModels: fusion?.models ?? [],
		stream: auto.streamSimple,
		fusionStream: fusion?.streamSimple as Stream,
		model: (id = "auto-balance"): Model<Api> => {
			const registeredModel = auto.models.find((m) => m.id === id);
			return { ...(registeredModel ?? { id, name: id, reasoning: true, input: ["text"], cost: zeroCost, contextWindow: 200000, maxTokens: 64000 }),
				api: "openai-completions", provider: "github-copilot-auto", baseUrl } as Model<Api>;
		},
		fusionModel: (): Model<Api> => ({ ...fusion.models[0], api: "openai-completions", provider: "github-copilot-fusion", baseUrl }) as Model<Api>,
		handlers,
	};
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
function messageOf(event: AssistantMessageEvent): AssistantMessage {
	return event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
}
function finalMessage(events: AssistantMessageEvent[]) { return messageOf(events.at(-1)!); }

const hydraScores = { code_gen: 0.41, debugging: 0.22, reasoning: 0.73, tool_use: 0.15 };
const modelCards = {
	hydra_scores: hydraScores,
	multi_turn_mode: "model_cards",
	multi_turn: { enabled: true, sigma: { code_gen: 0.238, debugging: 0.199, reasoning: 0.199, tool_use: 0.146 }, initial_skip: 2, escalate_threshold: 2, backoff_coefficient: 2, max_skip: 32, anchor_skip: 0, context_window: 5 },
};
function user(text: string, timestamp: number): Context["messages"][number] {
	return { role: "user", content: text, timestamp };
}
function ctxFor(sessionId: string) {
	return { sessionManager: { getSessionId: () => sessionId } };
}
function autoBodies() {
	return requests.filter(r => r.url.endsWith("/auto")).map(r => r.body);
}
function chatTokens() {
	return requests.filter(r => !r.url.endsWith("/auto")).map(r => r.headers.get("Copilot-Session-Token"));
}

function sseCompletion(endpoint: string) {
	if (endpoint === "/responses") {
		const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_1", model: selectedId, status: "completed", output: [item], usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } },
		];
		return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
	}
	return new Response(`data: ${JSON.stringify({ id: "completion-1", model: selectedId, choices: [
		{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" },
	], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
	{ headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
	vi.resetModules();
	selectedId = "mai-code-1.1-flash";
	autoResponse = undefined;
	autoHook = undefined;
	routeStatus = chatStatus = 200;
	requests = [];
	metaResponse = { auto: { tiers: [
		{ id: "balance", type: "auto", tier_level: "standard", status: { enabled: true, tier_picker_enabled: true } },
		{ id: "hydrafusion", type: "fusion", tier_level: "high", status: { enabled: true, tier_picker_enabled: true } },
	] } };
	metaStatus = 200;
	metaFailure = undefined;
	metaRequests = [];
	fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		if (url === `${baseUrl}/meta`) {
			metaRequests.push({ url, headers, method: init?.method, body: init?.body });
			if (metaFailure === "network") throw new Error("offline");
			if (metaFailure === "timeout") {
				return new Promise<Response>((_resolve, reject) => {
					init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
				});
			}
			if (metaFailure === "json") return new Response("not JSON");
			return Response.json(metaResponse, { status: metaStatus });
		}
		const body = JSON.parse(typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "{}");
		requests.push({ url, headers, body });
		if (url === `${baseUrl}/auto`) {
			const n = requests.filter(r => r.url.endsWith("/auto")).length;
			return Response.json(autoResponse ?? {
				selected_model: { id: selectedId }, session_token: `test-auto-token-${n}`,
				expires_at: Math.floor(Date.now() / 1000) + 86400,
				...autoHook?.(body, n),
			}, { status: routeStatus });
		}
		if (new URL(url).origin !== baseUrl || !["/chat/completions", "/responses", "/v1/messages"].includes(new URL(url).pathname)) {
			throw new Error(`Unexpected network request: ${url}`);
		}
		if (chatStatus !== 200) return Response.json({ error: { message: "upstream unavailable" } }, { status: chatStatus });
		return sseCompletion(new URL(url).pathname);
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("Fusion Standard entitlement discovery", () => {
	it("checks /meta before advertising Standard, without routing or generating", async () => {
		const ext = await loadExtension();
		expect(ext.fusionModels.map(m => m.id)).toEqual(["standard"]);
		expect(metaRequests).toHaveLength(1);
		expect(metaRequests[0]).toMatchObject({ url: `${baseUrl}/meta`, method: "GET", body: undefined });
		expect(metaRequests[0].headers.get("Authorization")).toBe("Bearer test-access-token");
		expect(metaRequests[0].headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
		expect(metaRequests[0].headers.get("X-GitHub-Api-Version")).toBe("2026-09-21");
		expect(metaRequests[0].headers.has("Copilot-Session-Token")).toBe(false);
		expect(requests).toHaveLength(0);
		await collect(ext.fusionStream(ext.fusionModel(), prompt));
		for (const request of requests) expect(request.headers.get("X-GitHub-Api-Version")).toBe("2026-08-01");
	});

	it.each([
		["missing auto metadata", {}],
		["null metadata", null],
		["invalid tiers", { auto: { tiers: {} } }],
		["no tiers", { auto: { tiers: [] } }],
		["classic balance only", { auto: { tiers: [{ id: "balance", type: "auto", tier_level: "standard", status: { enabled: true, tier_picker_enabled: true } }] } }],
		["hidden Fusion tiers", { auto: { tiers: [
			{ id: "balance", type: "auto", tier_level: "standard", status: { enabled: true, tier_picker_enabled: true } },
			{ id: "hydrafusion", type: "fusion", status: { enabled: true, tier_picker_enabled: false } },
		] } }],
		["disabled Standard", { auto: { tiers: [{ id: "balance", type: "auto", status: { enabled: false } }, { id: "hydrafusion", type: "fusion", status: { enabled: true } }] } }],
		["hidden Standard", { auto: { tiers: [{ id: "balance", type: "auto", status: { enabled: true, tier_picker_enabled: false } }, { id: "hydrafusion", type: "fusion", status: { enabled: true } }] } }],
		["missing status", { auto: { tiers: [{ id: "balance", type: "auto" }, { id: "hydrafusion", type: "fusion", status: { enabled: true } }] } }],
		["non-boolean flags", { auto: { tiers: [{ id: "balance", type: "auto", status: { enabled: "true", tier_picker_enabled: 1 } }, { id: "hydrafusion", type: "fusion", status: { enabled: true } }] } }],
		["malformed Fusion status", { auto: { tiers: [{ id: "balance", type: "auto", status: { enabled: true } }, { id: "hydrafusion", type: "fusion", status: { enabled: "false" } }] } }],
		["High and Max only", { auto: { tiers: ["hydrafusion", "hydrafusion-max"].map(id => ({ id, type: "fusion", status: { enabled: true, tier_picker_enabled: true } })) } }],
	])("does not advertise Fusion for %s and leaves Auto usable", async (_label, data) => {
		metaResponse = data;
		const ext = await loadExtension();
		expect(ext.fusionModels).toEqual([]);
		expect(ext.models.map(m => m.id)).toEqual(["auto", "auto-efficiency", "auto-balance", "auto-intelligence"]);
		const events = await collect(ext.stream(ext.model(), prompt));
		expect(events.at(-1)?.type, finalMessage(events).errorMessage).toBe("done");
		expect(requests[0].body).toEqual({ prompt: "Say hello", tier: "balance" });
	});

	it("advertises Standard when higher Fusion tiers are unavailable and picker visibility is omitted", async () => {
		metaResponse = { auto: { tiers: [
			{ id: "balance", type: "auto", status: { enabled: true } },
			{ id: "hydrafusion", type: "fusion", status: { enabled: false } },
		] } };
		const ext = await loadExtension();
		expect(ext.fusionModels.map(m => m.id)).toEqual(["standard"]);
		expect(requests).toHaveLength(0);
	});

	it.each([401, 403, 404, 500])("fails closed on /meta HTTP %s without breaking Auto", async (status) => {
		metaStatus = status;
		const ext = await loadExtension();
		expect(ext.fusionModels).toEqual([]);
		expect(ext.models).toHaveLength(4);
		expect(requests).toHaveLength(0);
	});

	it.each(["network", "json"] as const)("fails closed on /meta %s failure", async (failure) => {
		metaFailure = failure;
		const ext = await loadExtension();
		expect(ext.fusionModels).toEqual([]);
		expect(ext.models).toHaveLength(4);
	});

	it("bounds the metadata request with a timeout", async () => {
		metaFailure = "timeout";
		const ext = await loadExtension();
		expect(ext.fusionModels).toEqual([]);
		expect(ext.models).toHaveLength(4);
	}, 10000);

	it("does not advertise Fusion or request metadata without a Copilot login", async () => {
		vi.mocked(readFile).mockResolvedValueOnce("{}");
		const ext = await loadExtension();
		expect(ext.fusionModels).toEqual([]);
		expect(metaRequests).toHaveLength(0);
		expect(ext.models).toHaveLength(4);
	});

	it("bounds token refresh during startup before metadata discovery", async () => {
		vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ "github-copilot": { refresh: "test-refresh-token" } }));
		let refreshSignal: AbortSignal | undefined;
		fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
			refreshSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				refreshSignal!.addEventListener("abort", () => reject(refreshSignal!.reason), { once: true });
			});
		});
		const ext = await loadExtension();
		expect(refreshSignal?.aborted).toBe(true);
		expect(ext.fusionModels).toEqual([]);
		expect(ext.models).toHaveLength(4);
		expect(metaRequests).toHaveLength(0);
	}, 10000);

	it("rechecks entitlement on restart rather than persisting availability", async () => {
		const ext = await loadExtension();
		expect(ext.fusionModels).toHaveLength(1);
		vi.resetModules();
		metaResponse = { auto: { tiers: [] } };
		const restarted = await loadExtension();
		expect(restarted.fusionModels).toEqual([]);
		expect(metaRequests).toHaveLength(2);
		expect(requests).toHaveLength(0);
	});
});

describe("Fusion Standard multi-turn routing (observed native subset)", () => {
	async function runTurns(ext: Awaited<ReturnType<typeof loadExtension>>, texts: string[], sessionId: string, identify = true) {
		const messages: Context["messages"] = [];
		for (const [i, text] of texts.entries()) {
			messages.push(user(text, (i + 1) * 10));
			// pi emits `context` (with real roles) before every LLM call.
			if (identify) await ext.handlers.get("context")!({ type: "context", messages: [...messages] }, ctxFor(sessionId));
			const events = await collect(ext.fusionStream(ext.fusionModel(), { messages: [...messages] }, { sessionId }));
			messages.push(finalMessage(events));
		}
		return messages;
	}

	const escalated = { code_gen: 0.41, debugging: 0.9, reasoning: 0.95, tool_use: 0.15 }; // 2 dims rise > sigma
	const oneDimUp = { ...hydraScores, debugging: 0.9 }; // 1 dim rises > sigma
	const lower = { code_gen: 0.01, debugging: 0.01, reasoning: 0.02, tool_use: 0.01 };
	const turns = (n: number) => Array.from({ length: n }, (_, i) => `task ${i + 1}`);
	const intents = () => autoBodies().map(b => [b.multi_turn.routing_intent, b.multi_turn.turns_since_anchor, b.multi_turn.current_skip_window]);

	it("follows the native skip-window cadence and keeps the anchor's model and token", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		await runTurns(ext, turns(10), "cadence");
		// Checks on turns 2, 5 and 10; turns 3-4 and 6-9 make no /auto call.
		expect(intents()).toEqual([["anchor", 0, undefined], ["drift_check", 1, 2], ["drift_check", 4, 4], ["drift_check", 9, 8]]);
		expect(autoBodies()[1]).toEqual({
			prompt: "task 1\n\ntask 2", tier: "balance", has_image: false, fusion: true, hydra_rl_multi_turn: {},
			multi_turn: { routing_intent: "drift_check", turns_since_anchor: 1, current_skip_window: 2, anchor_cap_vector: hydraScores },
		});
		// Window = context_window (5) previous user messages + the current one.
		expect(autoBodies()[3].prompt).toBe(["task 5", "task 6", "task 7", "task 8", "task 9", "task 10"].join("\n\n"));
		expect(chatTokens()).toEqual(Array(10).fill("test-auto-token-1"));
	});

	it("caps the skip window at max_skip and truncates drift-prompt messages", async () => {
		autoHook = () => ({ ...modelCards, multi_turn: { ...modelCards.multi_turn, max_skip: 3, context_window: 1 } });
		const ext = await loadExtension();
		const long = `${"y".repeat(1500)}END`;
		await runTurns(ext, ["first", long, ...turns(10).slice(2)], "cap");
		expect(autoBodies()[1].prompt).toBe(`first\n\n${"y".repeat(1022)}`);
		// Windows 2, 3 (capped), 3: checks at since 1, 4, 8.
		expect(intents().slice(1)).toEqual([["drift_check", 1, 2], ["drift_check", 4, 3], ["drift_check", 8, 3]]);
	});

	it("escalates to the drift route when >= escalate_threshold capabilities rise above sigma", async () => {
		autoHook = (_body, n) => (n === 2 ? { ...modelCards, hydra_scores: escalated, selected_model: { id: "gpt-4o" } } : modelCards);
		const ext = await loadExtension();
		await runTurns(ext, turns(6), "escalate");
		const chats = requests.filter(r => !r.url.endsWith("/auto"));
		// The drift response's own model and token are used together; no extra anchor call.
		expect(chats[1].body.model).toBe("gpt-4o");
		expect(chatTokens()).toEqual(["test-auto-token-1", ...Array(5).fill("test-auto-token-2")]);
		// Reset: confirm check next turn against the new caps, then the doubling cadence.
		expect(intents()).toEqual([["anchor", 0, undefined], ["drift_check", 1, 2], ["drift_check", 1, 2], ["drift_check", 4, 4]]);
		expect(autoBodies()[2].multi_turn.anchor_cap_vector).toEqual(escalated);
		// The confirm check still sees older messages; later checks start from it.
		expect(autoBodies()[2].prompt).toBe("task 1\n\ntask 2\n\ntask 3");
		expect(autoBodies()[3].prompt).toBe("task 3\n\ntask 4\n\ntask 5\n\ntask 6");
	});

	it("escalation adopts the new token even when the router keeps the same model", async () => {
		autoHook = (_body, n) => (n === 2 ? { ...modelCards, hydra_scores: escalated } : modelCards);
		const ext = await loadExtension();
		await runTurns(ext, turns(3), "escalate-same");
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-2", "test-auto-token-2"]);
	});

	it.each([
		["one capability rises", oneDimUp, undefined],
		["router prefers a weaker model", lower, "gpt-4o"],
	])("stays on the anchor when the drift does not escalate (%s)", async (_label, scores, model) => {
		autoHook = (_body, n) => (n === 2 ? { ...modelCards, hydra_scores: scores, selected_model: { id: model ?? selectedId } } : modelCards);
		const ext = await loadExtension();
		await runTurns(ext, turns(3), "sticky");
		const chats = requests.filter(r => !r.url.endsWith("/auto"));
		expect(chats.map(c => c.body.model)).toEqual([selectedId, selectedId, selectedId]);
		expect(chatTokens()).toEqual(Array(3).fill("test-auto-token-1"));
		// Kept: turn 3 is inside the skip window.
		expect(autoBodies()).toHaveLength(2);
	});

	it("continues on the unexpired anchor when the drift check fails, and retries next turn", async () => {
		autoHook = (_body, n) => (n === 2 ? { session_token: "" } : modelCards);
		const ext = await loadExtension();
		await runTurns(ext, turns(3), "drift-fail");
		expect(intents()).toEqual([["anchor", 0, undefined], ["drift_check", 1, 2], ["drift_check", 2, 2]]);
		expect(chatTokens()).toEqual(Array(3).fill("test-auto-token-1"));
	});

	it("does not escalate when capabilities rise by exactly sigma", async () => {
		const atSigma = { ...hydraScores, debugging: 0.25, reasoning: 0.5 };
		const caps = { ...hydraScores, debugging: 0.25 - 0.125, reasoning: 0.5 - 0.25 };
		autoHook = (_body, n) => ({
			...modelCards, hydra_scores: n === 1 ? caps : atSigma,
			multi_turn: { ...modelCards.multi_turn, sigma: { code_gen: 0.25, debugging: 0.125, reasoning: 0.25, tool_use: 0.25 } },
		});
		const ext = await loadExtension();
		await runTurns(ext, turns(2), "at-sigma");
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-1"]);
	});

	it("can escalate again on the confirm check", async () => {
		const higher = { code_gen: 0.9, debugging: 0.95, reasoning: 0.99, tool_use: 0.9 };
		autoHook = (_body, n) => ({ ...modelCards, hydra_scores: n === 2 ? escalated : n === 3 ? higher : hydraScores });
		const ext = await loadExtension();
		await runTurns(ext, turns(4), "re-escalate");
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-2", "test-auto-token-3", "test-auto-token-3"]);
		expect(intents()).toEqual([["anchor", 0, undefined], ["drift_check", 1, 2], ["drift_check", 1, 2], ["drift_check", 1, 2]]);
		expect(autoBodies()[3].multi_turn.anchor_cap_vector).toEqual(higher);
	});

	it("re-anchors on the current message when the anchor nears expiry inside a skip window", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const messages = await runTurns(ext, turns(2), "skip-expiry");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
		const next = [...messages, user("task 3", 30)];
		await ext.handlers.get("context")!({ type: "context", messages: next }, ctxFor("skip-expiry"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: next }, { sessionId: "skip-expiry" }));
		expect(autoBodies()[2]).toMatchObject({ prompt: "task 3", multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 } });
		expect(chatTokens().at(-1)).toBe("test-auto-token-3");
	});

	it("keeps pre-compaction user messages in the forced drift check", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		await runTurns(ext, turns(3), "compact-history");
		await ext.handlers.get("session_compact")!({}, ctxFor("compact-history"));
		// pi's compaction dropped turns 1-3 from the context; only the new message remains.
		const next = [user("task 4", 40)];
		await ext.handlers.get("context")!({ type: "context", messages: next }, ctxFor("compact-history"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: next }, { sessionId: "compact-history" }));
		expect(intents()[2]).toEqual(["drift_check", 3, 4]);
		expect(autoBodies()[2].prompt).toBe("task 1\n\ntask 2\n\ntask 3\n\ntask 4");
	});

	it("a failed forced check is retried on the next turn", async () => {
		autoHook = (_body, n) => (n === 3 ? { session_token: "" } : modelCards);
		const ext = await loadExtension();
		const messages = await runTurns(ext, turns(3), "forced-fail");
		await ext.handlers.get("session_compact")!({}, ctxFor("forced-fail"));
		let ctx = [...messages];
		for (const n of [4, 5]) {
			ctx = [...ctx, user(`task ${n}`, n * 10)];
			await ext.handlers.get("context")!({ type: "context", messages: ctx }, ctxFor("forced-fail"));
			ctx.push(finalMessage(await collect(ext.fusionStream(ext.fusionModel(), { messages: ctx }, { sessionId: "forced-fail" }))));
		}
		expect(intents().slice(2)).toEqual([["drift_check", 3, 4], ["drift_check", 4, 4]]);
		expect(chatTokens()).toEqual(Array(5).fill("test-auto-token-1"));
	});

	it("compaction keeps the anchor but forces a check on the next turn", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const messages = await runTurns(ext, turns(3), "compact-force");
		expect(autoBodies()).toHaveLength(2);
		await ext.handlers.get("session_compact")!({}, ctxFor("compact-force"));
		const next = [...messages, user("task 4", 40)];
		await ext.handlers.get("context")!({ type: "context", messages: next }, ctxFor("compact-force"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: next }, { sessionId: "compact-force" }));
		// Turn 4 (since 3) would be skipped without compaction; window doubled to 4.
		expect(intents()[2]).toEqual(["drift_check", 3, 4]);
		expect(chatTokens()).toEqual(Array(4).fill("test-auto-token-1"));
	});

	it.each([
		["no model_cards mode", { ...modelCards, multi_turn_mode: undefined }],
		["multi-turn disabled", { ...modelCards, multi_turn: { ...modelCards.multi_turn, enabled: false } }],
		["missing hydra_scores", { ...modelCards, hydra_scores: undefined }],
		["three hydra_scores", { ...modelCards, hydra_scores: { code_gen: 1, debugging: 1, reasoning: 1 } }],
		["non-finite hydra_scores", { ...modelCards, hydra_scores: { ...hydraScores, reasoning: "high" } }],
		["invalid context window", { ...modelCards, multi_turn: { ...modelCards.multi_turn, context_window: 0 } }],
		["non-empty hydra_rl_multi_turn", { ...modelCards, hydra_rl_multi_turn: { opaque: "opaque-state" } }],
		["non-empty hydra_rl_multi_turn (numeric)", { ...modelCards, hydra_rl_multi_turn: { n: 3 } }],
		["scalar sigma", { ...modelCards, multi_turn: { ...modelCards.multi_turn, sigma: 0.2 } }],
		["sigma missing a capability", { ...modelCards, multi_turn: { ...modelCards.multi_turn, sigma: { code_gen: 0.2, debugging: 0.2, reasoning: 0.2 } } }],
		["escalate_threshold out of range", { ...modelCards, multi_turn: { ...modelCards.multi_turn, escalate_threshold: 5 } }],
		["unobserved anchor_skip", { ...modelCards, multi_turn: { ...modelCards.multi_turn, anchor_skip: 1 } }],
		["fractional backoff", { ...modelCards, multi_turn: { ...modelCards.multi_turn, backoff_coefficient: 1.5 } }],
	])("anchors every turn when drift mode is not offered (%s)", async (_label, response) => {
		autoHook = () => response;
		const ext = await loadExtension();
		await runTurns(ext, ["first", "second"], "drift-off");
		const bodies = autoBodies();
		expect(bodies[1]).toEqual({
			prompt: "second", tier: "balance", has_image: false, fusion: true, hydra_rl_multi_turn: {},
			multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
		});
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-2"]);
		// Never echo or act on unexpected multi-turn content.
		expect(JSON.stringify(bodies)).not.toContain("opaque-state");
	});

	it("anchors every turn when pi supplied no real-user identities", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		await runTurns(ext, ["first", "second"], "no-identity", false);
		expect(autoBodies()[1].multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
	});

	it("keeps the current route for an image-only later turn", async () => {
		const ext = await loadExtension();
		const messages = await runTurns(ext, ["first"], "image-only");
		const image = { role: "user" as const, timestamp: 20, content: [{ type: "image" as const, data: "dGVzdA==", mimeType: "image/png" }] };
		await ext.handlers.get("context")!({ type: "context", messages: [...messages, image] }, ctxFor("image-only"));
		const events = await collect(ext.fusionStream(ext.fusionModel(), { messages: [...messages, image] }, { sessionId: "image-only" }));
		expect(finalMessage(events).stopReason).toBe("stop");
		expect(autoBodies()).toHaveLength(1);
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-1"]);
	});

	it("switching classic -> Fusion -> classic in one session never reuses the other mode's token", async () => {
		autoHook = (body) => (body.fusion ? modelCards : undefined);
		const ext = await loadExtension();
		const m1 = user("first", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [m1] }, ctxFor("switch"));
		const a1 = finalMessage(await collect(ext.stream(ext.model(), { messages: [m1] }, { sessionId: "switch" })));
		const m2 = user("second", 20);
		await ext.handlers.get("context")!({ type: "context", messages: [m1, a1, m2] }, ctxFor("switch"));
		const a2 = finalMessage(await collect(ext.fusionStream(ext.fusionModel(), { messages: [m1, a1, m2] }, { sessionId: "switch" })));
		const m3 = user("third", 30);
		await ext.handlers.get("context")!({ type: "context", messages: [m1, a1, m2, a2, m3] }, ctxFor("switch"));
		await collect(ext.stream(ext.model(), { messages: [m1, a1, m2, a2, m3] }, { sessionId: "switch" }));
		const bodies = autoBodies();
		expect(bodies[0]).toEqual({ prompt: "first", tier: "balance" });
		expect(bodies[1].multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
		expect(bodies[2]).toEqual({ prompt: "third", tier: "balance" });
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-2", "test-auto-token-3"]);
	});

	it("concurrent calls for one new turn make exactly one drift request", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const messages = await runTurns(ext, ["first"], "concurrent");
		messages.push(user("second", 20));
		await ext.handlers.get("context")!({ type: "context", messages }, ctxFor("concurrent"));
		await Promise.all([1, 2].map(() => collect(ext.fusionStream(ext.fusionModel(), { messages: [...messages] }, { sessionId: "concurrent" }))));
		expect(autoBodies()).toHaveLength(2);
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-1", "test-auto-token-1"]);
	});

	it("restart forgets the anchor and re-anchors", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const messages = await runTurns(ext, ["first"], "drift-restart");
		vi.resetModules();
		const restarted = await loadExtension();
		await collect(restarted.fusionStream(restarted.fusionModel(), { messages: [...messages, user("second", 20)] }, { sessionId: "drift-restart" }));
		expect(autoBodies()[1].multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
	});
});

describe("Real user-turn identity", () => {
	it("routes on the real user prompt, not a later custom/bash message mapped to role user", async () => {
		const ext = await loadExtension();
		const real = user("real prompt", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [real, { role: "custom", content: "injected", timestamp: 11 }] }, ctxFor("identity"));
		const context: Context = { messages: [real, user("injected", 11)] };
		await collect(ext.fusionStream(ext.fusionModel(), context, { sessionId: "identity" }));
		await collect(ext.stream(ext.model(), context, { sessionId: "identity-classic" }));
		expect(autoBodies()[0].prompt).toBe("real prompt");
		// Classic falls back positionally when pi gave no identities for its session.
		expect(autoBodies()[1]).toEqual({ prompt: "injected", tier: "balance" });
		await ext.handlers.get("context")!({ type: "context", messages: [real] }, ctxFor("identity-classic2"));
		await collect(ext.stream(ext.model(), context, { sessionId: "identity-classic2" }));
		expect(autoBodies()[2]).toEqual({ prompt: "real prompt", tier: "balance" });
	});

	it("an extra injected message does not count as a new Fusion turn", async () => {
		const ext = await loadExtension();
		const real = user("real prompt", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [real] }, ctxFor("identity-turn"));
		const first = finalMessage(await collect(ext.fusionStream(ext.fusionModel(), { messages: [real] }, { sessionId: "identity-turn" })));
		await ext.handlers.get("context")!({ type: "context", messages: [real, first, { role: "bashExecution", timestamp: 30 }] }, ctxFor("identity-turn"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [real, first, user("$ ls", 30)] }, { sessionId: "identity-turn" }));
		expect(autoBodies()).toHaveLength(1);
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-1"]);
	});

	it("treats compaction summarization as auxiliary: reuses the route without advancing turn state", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const t1 = user("first", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [t1] }, ctxFor("aux"));
		const a1 = finalMessage(await collect(ext.fusionStream(ext.fusionModel(), { messages: [t1] }, { sessionId: "aux" })));
		// A summarizer that reuses the session id sends one synthetic user message.
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [user("Summarize the conversation", 99)] }, { sessionId: "aux" }));
		expect(autoBodies()).toHaveLength(1);
		const t2 = user("second", 20);
		await ext.handlers.get("context")!({ type: "context", messages: [t1, a1, t2] }, ctxFor("aux"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [t1, a1, t2] }, { sessionId: "aux" }));
		expect(autoBodies()[1].multi_turn).toMatchObject({ routing_intent: "drift_check", turns_since_anchor: 1 });
		expect(autoBodies()[1].prompt).toBe("first\n\nsecond");
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-1", "test-auto-token-1"]);
	});

	it("an auxiliary request without a route makes a one-off anchor that is not stored", async () => {
		const ext = await loadExtension();
		await ext.handlers.get("context")!({ type: "context", messages: [user("real", 10)] }, ctxFor("aux-cold"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [user("Summarize", 99)] }, { sessionId: "aux-cold" }));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [user("real", 10)] }, { sessionId: "aux-cold" }));
		expect(autoBodies().map(b => b.prompt)).toEqual(["Summarize", "real"]);
		expect(chatTokens()).toEqual(["test-auto-token-1", "test-auto-token-2"]);
	});

	it("an injected message with the same millisecond timestamp is not a real user turn", async () => {
		const ext = await loadExtension();
		const real = user("real prompt", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [real, { role: "custom", content: "injected", timestamp: 10 }] }, ctxFor("same-ms"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [real, user("injected", 10)] }, { sessionId: "same-ms" }));
		expect(autoBodies()[0].prompt).toBe("real prompt");
	});

	it("a summarizer under a throwaway session id is ephemeral: capped prompt, no retained state", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const t1 = user("first", 10);
		await ext.handlers.get("context")!({ type: "context", messages: [t1] }, ctxFor("real-session"));
		const a1 = finalMessage(await collect(ext.fusionStream(ext.fusionModel(), { messages: [t1] }, { sessionId: "real-session" })));
		const transcript = `${"x".repeat(40_000)}TAIL`;
		for (const id of ["uuid-a", "uuid-a"]) {
			await collect(ext.fusionStream(ext.fusionModel(), { messages: [user(transcript, 99)] }, { sessionId: id }));
		}
		const [, sum1, sum2] = autoBodies();
		expect(sum1.prompt.length).toBe(16_000);
		expect(sum1.prompt.endsWith("TAIL")).toBe(true);
		expect(sum2.multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
		// The real session's anchor and turn count are untouched.
		const t2 = user("second", 20);
		await ext.handlers.get("context")!({ type: "context", messages: [t1, a1, t2] }, ctxFor("real-session"));
		await collect(ext.fusionStream(ext.fusionModel(), { messages: [t1, a1, t2] }, { sessionId: "real-session" }));
		expect(autoBodies()[3].multi_turn).toMatchObject({ routing_intent: "drift_check", turns_since_anchor: 1 });
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
	});

	it("a summarizer under a throwaway id does not retain classic state either", async () => {
		const ext = await loadExtension();
		await ext.handlers.get("context")!({ type: "context", messages: [user("real", 10)] }, ctxFor("classic-real"));
		for (const _ of [1, 2]) await collect(ext.stream(ext.model(), { messages: [user("Summarize", 99)] }, { sessionId: "uuid-b" }));
		expect(autoBodies()).toHaveLength(2);
	});

	it("a same-index replacement (/tree edit) is a new turn, and tree navigation drops the Fusion anchor", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const turn = async (text: string, ts: number) => {
			await ext.handlers.get("context")!({ type: "context", messages: [user(text, ts)] }, ctxFor("tree"));
			await collect(ext.fusionStream(ext.fusionModel(), { messages: [user(text, ts)] }, { sessionId: "tree" }));
		};
		await turn("original", 10);
		await turn("edited", 20);
		expect(autoBodies()[1].multi_turn.routing_intent).toBe("drift_check");
		await ext.handlers.get("session_tree")!({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctxFor("tree"));
		await turn("other branch", 30);
		expect(autoBodies()[2].multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
	});
});

describe("Auto response identity and resume", () => {
	it("registers the Fusion Standard provider separately without changing Auto model IDs", async () => {
		const ext = await loadExtension();
		expect(ext.models.map(m => m.id)).toEqual(["auto", "auto-efficiency", "auto-balance", "auto-intelligence"]);
		expect(ext.fusionModels.map(m => m.id)).toEqual(["standard"]);
		expect(ext.fusionModels[0].name).toBe("Standard");
	});

	it("persists Fusion identity and restores its actual producing model", async () => {
		const { fusionModel } = await loadExtension();
		const native = nativeMessage({ api: "openai-responses", model: "gpt-6-luna", responseId: "resp-fusion" });
		const saved = JSON.parse(JSON.stringify(messageOf(asFusionEvent({ type: "done", reason: "stop", message: native }, fusionModel()))));
		expect(saved).toMatchObject({ provider: "github-copilot-fusion", model: "standard", responseModel: "gpt-6-luna" });
		expect(saved).not.toHaveProperty("copilot-session-token");
		const restored = restoreFusionContext({ messages: [saved, prompt.messages[0]] });
		expect(restored.messages[0]).toMatchObject({ provider: "github-copilot", model: "gpt-6-luna", api: "openai-responses" });
		expect(restored.messages[0]).not.toHaveProperty("copilotFusionRoute");
	});

	it("saves Fusion, restarts, resumes Standard and makes a fresh route with a new token", async () => {
		selectedId = "gpt-6-luna";
		const ext = await loadExtension();
		const model = ext.fusionModel();
		const events = await collect(ext.fusionStream(model, prompt, { sessionId: "fusion-resume" }));
		expect(events.at(-1)?.type, finalMessage(events).errorMessage).toBe("done");
		const dir = mkdtempSync(path.join(tmpdir(), "copilot-fusion-resume-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir);
		session.appendModelChange(model.provider, model.id);
		session.appendMessage(prompt.messages[0]);
		session.appendMessage(finalMessage(events));
		const file = session.getSessionFile()!;
		const serialized = readFileSync(file, "utf8");
		expect(serialized).not.toContain("test-auto-token");
		expect(serialized).not.toContain("test-access-token");

		// No in-memory route or credentials survive the simulated process restart.
		vi.resetModules();
		const restarted = await loadExtension();
		const resumed = SessionManager.open(file).buildSessionContext();
		expect(resumed.model).toEqual({ provider: "github-copilot-fusion", modelId: "standard" });
		expect(resumed.messages.at(-1)).toMatchObject({ provider: "github-copilot-fusion", model: "standard", responseModel: "gpt-6-luna" });
		// Resume the SAME user turn: this must route again even without a new prompt.
		const resumedContext: Context = { messages: resumed.messages as Context["messages"] };
		const resumedEvents = await collect(restarted.fusionStream(restarted.fusionModel(), resumedContext, { sessionId: "fusion-resume" }));
		expect(resumedEvents.at(-1)?.type, finalMessage(resumedEvents).errorMessage).toBe("done");
		const routes = requests.filter(r => r.url.endsWith("/auto"));
		expect(routes).toHaveLength(2);
		expect(routes[1].body).toMatchObject({ prompt: "Say hello", tier: "balance", fusion: true });
		expect(requests.at(-1)!.url).toBe(`${baseUrl}/responses`);
		expect(requests.at(-1)!.body.model).toBe("gpt-6-luna");
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-2");
		expect(finalMessage(resumedEvents)).toMatchObject({ provider: "github-copilot-fusion", model: "standard", responseModel: "gpt-6-luna" });
	});

	it("registers only current VS Code tier model IDs", async () => {
		const ext = await loadExtension();
		expect(ext.models.map(m => m.id)).toEqual(["auto", "auto-efficiency", "auto-balance", "auto-intelligence"]);
	});

	it.each(["auto", "auto-efficiency", "auto-balance", "auto-intelligence"])("persists and restores %s, not the concrete model", async (id) => {
		const ext = await loadExtension();
		const model = ext.model(id);
		const events = await collect(ext.stream(model, prompt, { sessionId: "conversation" }));
		expect(events.at(-1)?.type, finalMessage(events).errorMessage).toBe("done");
		for (const event of events) {
			expect(messageOf(event)).toMatchObject({ provider: "github-copilot-auto", model: id, responseModel: selectedId });
		}
		const result = finalMessage(events);
		const { cost: _cost, ...tokens } = usage;
		expect(result.usage).toMatchObject(tokens);
		const dir = mkdtempSync(path.join(tmpdir(), "copilot-auto-resume-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir);
		session.appendModelChange(model.provider, model.id);
		session.appendMessage(prompt.messages[0]);
		session.appendMessage(result);
		const file = session.getSessionFile()!;
		expect(readFileSync(file, "utf8")).not.toContain("test-auto-token");
		expect(readFileSync(file, "utf8")).not.toContain("test-access-token");
		const resumed = SessionManager.open(file).buildSessionContext();
		expect(resumed.model).toEqual({ provider: model.provider, modelId: id });

		// Simulate a restarted extension: no memory/token cache survives.
		vi.resetModules();
		const restarted = await loadExtension();
		const resumedContext: Context = { messages: [...resumed.messages as Context["messages"], ...prompt.messages] };
		await collect(restarted.stream(restarted.model(id), resumedContext, { sessionId: "conversation" }));
		expect(requests.filter(r => r.url.endsWith("/auto"))).toHaveLength(2);
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-2");
		expect(requests.at(-1)!.body.model).toBe(selectedId);
	});

	it("demonstrates why unchanged native messages restored the direct model", () => {
		const session = SessionManager.inMemory();
		session.appendModelChange("github-copilot-auto", "auto-balance");
		session.appendMessage(nativeMessage());
		expect(session.buildSessionContext().model).toEqual({ provider: "github-copilot", modelId: selectedId });
	});

	it.each(["error", "aborted"] as const)("rewrites %s and partial events without mutating the source", async (reason) => {
		const { model } = await loadExtension();
		const native = nativeMessage({ stopReason: reason, errorMessage: "failed" });
		const error = asAutoEvent({ type: "error", reason, error: native }, model("auto-intelligence"));
		const partial = asAutoEvent({ type: "thinking_delta", contentIndex: 0, delta: "hi", partial: native }, model("auto-intelligence"));
		for (const event of [error, partial]) expect(messageOf(event)).toMatchObject({ provider: "github-copilot-auto", model: "auto-intelligence" });
		expect(native.provider).toBe("github-copilot");
		expect(native.model).toBe(selectedId);
	});

	it("restores original history provenance and preserves signatures, tools, usage and response IDs", async () => {
		const { model } = await loadExtension();
		const native = nativeMessage({ api: "anthropic-messages", model: "claude-haiku-4.5", responseId: "response-123",
			usage: { ...usage, cost: { ...zeroCost, input: 0.02, output: 0.03, total: 0.05 } },
			content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "signed" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }] });
		const saved = JSON.parse(JSON.stringify(messageOf(asAutoEvent({ type: "done", reason: "toolUse", message: native }, model()))));
		const restored = restoreAutoContext({ messages: [saved, prompt.messages[0]] });
		expect(restored.messages[0]).toMatchObject(native);
		expect(saved.provider).toBe("github-copilot-auto");
		expect(restored.messages[0]).not.toHaveProperty("copilotAutoRoute");
		// A new target must not re-label the old signed history as its own.
		expect(restored.messages[0]).toMatchObject({ model: "claude-haiku-4.5", api: "anthropic-messages" });
		const legacy = nativeMessage();
		expect(restoreAutoContext({ messages: [legacy] }).messages[0]).toBe(legacy);
	});
});

describe("Auto request attribution contract", () => {
	it("sends the observed Fusion Standard routing flags and keeps the router token", async () => {
		const ext = await loadExtension();
		const events = await collect(ext.fusionStream(ext.fusionModel(), prompt, { sessionId: "fusion-standard" }));
		expect(events.at(-1)?.type, finalMessage(events).errorMessage).toBe("done");
		const [router, chat] = requests;
		expect(new URL(router.url).pathname).toBe("/auto");
		expect(router.body).toEqual({
			prompt: "Say hello",
			tier: "balance",
			has_image: false,
			fusion: true,
			hydra_rl_multi_turn: {},
			multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 },
		});
		expect(["/chat/completions", "/responses", "/v1/messages"]).toContain(new URL(chat.url).pathname);
		expect(chat.body.model).toBe(selectedId);
		expect(chat.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
		expect(finalMessage(events)).toMatchObject({ provider: "github-copilot-fusion", model: "standard", responseModel: selectedId });
	});

	it("sets Fusion image presence while leaving classic Auto unchanged", async () => {
		const ext = await loadExtension();
		const imagePrompt: Context = { messages: [{ role: "user", timestamp: 1, content: [
			{ type: "text", text: "Describe" }, { type: "image", data: "dGVzdA==", mimeType: "image/png" },
		] }] };
		chatStatus = 400;
		await collect(ext.fusionStream(ext.fusionModel(), imagePrompt, { maxRetries: 0 }));
		expect(requests[0].body).toMatchObject({ fusion: true, has_image: true });
		await collect(ext.stream(ext.model(), imagePrompt, { maxRetries: 0 }));
		expect(requests[2].body).toEqual({ prompt: "Describe", tier: "balance", has_image: true });
	});

	it("reuses Fusion route during a tool continuation and re-routes on the next user turn", async () => {
		const ext = await loadExtension();
		const first = finalMessage(await collect(ext.fusionStream(ext.fusionModel(), prompt, { sessionId: "fusion-turns" })));
		const continuation: Context = { messages: [...prompt.messages, first] };
		await collect(ext.fusionStream(ext.fusionModel(), continuation, { sessionId: "fusion-turns" }));
		expect(requests.filter(r => r.url.endsWith("/auto"))).toHaveLength(1);
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");

		const nextTurn: Context = { messages: [...continuation.messages, { role: "user", content: "Next task", timestamp: 3 }] };
		await collect(ext.fusionStream(ext.fusionModel(), nextTurn, { sessionId: "fusion-turns" }));
		const routes = requests.filter(r => r.url.endsWith("/auto"));
		expect(routes).toHaveLength(2);
		expect(routes[1].body).toMatchObject({ tier: "balance", fusion: true, hydra_rl_multi_turn: {}, multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 } });
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-2");
	});

	it("reuses the native Standard route for a Responses tool-call and result", async () => {
		selectedId = "gpt-6-luna";
		const ext = await loadExtension();
		const model = ext.fusionModel();
		const initial = await collect(ext.fusionStream(model, prompt, { sessionId: "fusion-tool-result" }));
		expect(initial.at(-1)?.type, finalMessage(initial).errorMessage).toBe("done");
		const toolCall = nativeMessage({
			api: "openai-responses", model: selectedId, stopReason: "toolUse", responseId: "resp-tool",
			content: [{ type: "toolCall", id: "call_123|fc_123", name: "read", arguments: { path: "marker.txt" } }],
		});
		const saved = messageOf(asFusionEvent({ type: "done", reason: "toolUse", message: toolCall }, model));
		const context: Context = { messages: [prompt.messages[0], saved, {
			role: "toolResult", toolCallId: "call_123|fc_123", toolName: "read",
			content: [{ type: "text", text: "MARKER" }], isError: false, timestamp: 3,
		}] };
		const continued = await collect(ext.fusionStream(model, context, { sessionId: "fusion-tool-result" }));
		expect(continued.at(-1)?.type, finalMessage(continued).errorMessage).toBe("done");
		expect(requests.filter(r => r.url.endsWith("/auto"))).toHaveLength(1);
		const chat = requests.at(-1)!;
		expect(chat.url).toBe(`${baseUrl}/responses`);
		expect(chat.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
		expect(chat.body.input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "function_call", name: "read", call_id: "call_123" }),
			expect.objectContaining({ type: "function_call_output", call_id: "call_123", output: "MARKER" }),
		]));
		expect(finalMessage(continued)).toMatchObject({ provider: "github-copilot-fusion", model: "standard", responseModel: selectedId });
	});

	it("keeps the Fusion anchor across compaction without re-routing the same turn", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const model = ext.fusionModel();
		const t1: Context = { messages: [user("First task", 10)] };
		await ext.handlers.get("context")!({ type: "context", messages: t1.messages }, ctxFor("fusion-compact"));
		const first = finalMessage(await collect(ext.fusionStream(model, t1, { sessionId: "fusion-compact" })));
		await ext.handlers.get("session_compact")!({}, ctxFor("fusion-compact"));
		// Overflow recovery retries the same user turn after compaction: no new route.
		await collect(ext.fusionStream(model, t1, { sessionId: "fusion-compact" }));
		expect(autoBodies()).toHaveLength(1);
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
		const t2: Context = { messages: [...t1.messages, first, user("Second task", 20)] };
		await ext.handlers.get("context")!({ type: "context", messages: t2.messages }, ctxFor("fusion-compact"));
		await collect(ext.fusionStream(model, t2, { sessionId: "fusion-compact" }));
		expect(autoBodies()[1].multi_turn).toMatchObject({ routing_intent: "drift_check", turns_since_anchor: 1 });
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
	});

	it("re-anchors instead of drift-checking a near-expiry anchor, and fails closed if that fails", async () => {
		autoHook = () => modelCards;
		const ext = await loadExtension();
		const model = ext.fusionModel();
		const t1: Context = { messages: [user("First task", 10)] };
		const first = finalMessage(await collect(ext.fusionStream(model, t1, { sessionId: "fusion-expiry" })));
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
		routeStatus = 503;
		const t2: Context = { messages: [...t1.messages, first, user("Second task", 20)] };
		const failed = await collect(ext.fusionStream(model, t2, { sessionId: "fusion-expiry" }));
		expect(finalMessage(failed)).toMatchObject({ provider: "github-copilot-fusion", model: "standard", stopReason: "error" });
		expect(autoBodies()).toHaveLength(2);
		expect(autoBodies()[1].multi_turn).toEqual({ routing_intent: "anchor", turns_since_anchor: 0 });
		expect(requests.filter(r => !r.url.endsWith("/auto"))).toHaveLength(1);
	});

	it("keeps the existing Auto request body free of Fusion-only flags", async () => {
		const ext = await loadExtension();
		await collect(ext.stream(ext.model(), prompt));
		expect(requests[0].body).toEqual({ prompt: "Say hello", tier: "balance" });
	});

	it.each([
		["mai-code-1.1-flash", "/chat/completions"],
		["gpt-4o", "/chat/completions"],
		["gpt-5-test-unknown", "/responses"],
		["gpt-5.3-codex", "/responses"],
		["claude-test-unknown", "/v1/messages"],
		["claude-haiku-4.5", "/v1/messages"],
	])("sends concrete %s with router token and identity to %s", async (id, endpoint) => {
		selectedId = id;
		chatStatus = 400; // Request serialization is real; no vendor SSE parser needed here.
		const ext = await loadExtension();
		const events = await collect(ext.stream(ext.model(), prompt, { sessionId: "headers", maxRetries: 0, headers: {
			"copilot-session-token": "stale-caller-token", "authorization": "Bearer placeholder",
			"copilot-integration-id": "wrong", "editor-version": "old", "x-test-custom": "kept",
		} }));
		expect(requests).toHaveLength(2);
		const [router, chat] = requests;
		const catalogApi = getModels("github-copilot").find(m => m.id === id)?.api;
		const catalogEndpoint = catalogApi === "openai-responses" ? "/responses" : catalogApi === "anthropic-messages" ? "/v1/messages" : undefined;
		expect(new URL(chat.url).pathname).toBe(catalogEndpoint ?? endpoint);
		expect(chat.body.model).toBe(id);
		expect(chat.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
		expect(chat.headers.get("Authorization")).toBe("Bearer test-access-token");
		for (const key of ["User-Agent", "Editor-Version", "Editor-Plugin-Version", "Copilot-Integration-Id", "X-GitHub-Api-Version", "VScode-SessionId", "VScode-MachineId", "Editor-Device-Id"]) {
			expect(chat.headers.get(key)).toBe(router.headers.get(key));
		}
		expect(chat.headers.get("X-Initiator")).toBe("user");
		expect(chat.headers.get("OpenAI-Intent")).toBe("conversation-edits");
		expect(chat.headers.get("X-Interaction-Type")).toBe("conversation");
		expect(chat.headers.get("X-Request-Id")).toMatch(/[0-9a-f-]{36}/);
		expect(chat.headers.get("X-Agent-Task-Id")).toBe(chat.headers.get("X-Request-Id"));
		expect(chat.headers.get("x-test-custom")).toBe("kept");
		expect(finalMessage(events)).toMatchObject({ provider: "github-copilot-auto", model: "auto-balance", stopReason: "error" });
	});

	it.each([
		["auto", "balance"],
		["auto-eco", "efficiency"],
		["auto-balanced", "balance"],
		["auto-max", "intelligence"],
		["auto-efficiency", "efficiency"],
		["auto-balance", "balance"],
		["auto-intelligence", "intelligence"],
	])("sends current VS Code tier value for %s", async (id, tier) => {
		const ext = await loadExtension();
		await collect(ext.stream(ext.model(id), prompt));
		expect(requests[0].body.tier).toBe(tier);
	});

	it("reuses routing and token on following turns, but obtains a fresh pair for tier changes", async () => {
		const ext = await loadExtension();
		const first = finalMessage(await collect(ext.stream(ext.model(), prompt, { sessionId: "sticky" })));
		const followUp: Context = { messages: [...prompt.messages, first, ...prompt.messages] };
		await collect(ext.stream(ext.model(), followUp, { sessionId: "sticky" }));
		expect(requests).toHaveLength(3);
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-1");
		await collect(ext.stream(ext.model("auto-intelligence"), followUp, { sessionId: "sticky" }));
		expect(requests.at(-2)!.body.tier).toBe("intelligence");
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-2");
	});

	it("isolates conversation tokens, including unkeyed calls", async () => {
		const ext = await loadExtension();
		for (const sessionId of ["a", "b", undefined, undefined]) await collect(ext.stream(ext.model(), prompt, { sessionId }));
		expect(requests.filter(r => r.url.endsWith("/auto"))).toHaveLength(4);
	});

	it("does not reuse expired tokens or fall back to an unselected model", async () => {
		const ext = await loadExtension();
		await collect(ext.stream(ext.model(), prompt, { sessionId: "expired" }));
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 86400000);
		routeStatus = 503;
		const failed = await collect(ext.stream(ext.model(), prompt, { sessionId: "expired" }));
		expect(requests).toHaveLength(3); // Only a router request, no chat with stale token.
		expect(finalMessage(failed).stopReason).toBe("error");
		routeStatus = 200;
		chatStatus = 503;
		await collect(ext.stream(ext.model(), prompt, { sessionId: "new", maxRetries: 0 }));
		expect(requests).toHaveLength(5); // Exactly one selected-model attempt.
	});

	it("does not reuse the previous tier's token when routing a new tier fails", async () => {
		const ext = await loadExtension();
		await collect(ext.stream(ext.model(), prompt, { sessionId: "tier-fail" }));
		routeStatus = 503;
		const result = finalMessage(await collect(ext.stream(ext.model("auto-intelligence"), prompt, { sessionId: "tier-fail" })));
		expect(requests).toHaveLength(3);
		expect(result).toMatchObject({ model: "auto-intelligence", stopReason: "error" });
	});

	it("invalidates only the compacted conversation, using Pi's actual session ID", async () => {
		const ext = await loadExtension();
		for (const sessionId of ["a", "b"]) await collect(ext.stream(ext.model(), prompt, { sessionId }));
		await ext.handlers.get("session_compact")!({}, { sessionManager: { getSessionId: () => "a" } });
		await collect(ext.stream(ext.model(), prompt, { sessionId: "b" }));
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-2");
		await collect(ext.stream(ext.model(), prompt, { sessionId: "a" }));
		expect(requests.at(-1)!.headers.get("Copilot-Session-Token")).toBe("test-auto-token-3");
	});

	it("keeps signed Anthropic history on the actual wire request", async () => {
		selectedId = "claude-haiku-4.5";
		chatStatus = 400;
		const ext = await loadExtension();
		const original = nativeMessage({ model: selectedId, api: "anthropic-messages", content: [
			{ type: "thinking", thinking: "thought", thinkingSignature: "test-thinking-signature" },
			{ type: "text", text: "Hello" },
		] });
		const saved = messageOf(asAutoEvent({ type: "done", reason: "stop", message: original }, ext.model()));
		await collect(ext.stream(ext.model(), { messages: [...prompt.messages, saved, ...prompt.messages] }, { maxRetries: 0 }));
		const assistant = requests.at(-1)!.body.messages.find((m: any) => m.role === "assistant");
		expect(assistant.content).toContainEqual({ type: "thinking", thinking: "thought", signature: "test-thinking-signature" });
	});

	it.each([undefined, 0, -1])("rejects missing/expired session expiry (%j)", async (expires_at) => {
		autoResponse = { selected_model: { id: selectedId }, session_token: "test-token", expires_at };
		const ext = await loadExtension();
		expect(finalMessage(await collect(ext.stream(ext.model(), prompt))).stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it.each(["", "   "])("rejects an empty Auto session token (%j) before chat", async (session_token) => {
		autoResponse = { selected_model: { id: selectedId }, session_token, expires_at: Date.now() / 1000 + 86400 };
		const ext = await loadExtension();
		const events = await collect(ext.stream(ext.model("auto-efficiency"), prompt));
		expect(requests).toHaveLength(1);
		expect(finalMessage(events)).toMatchObject({ model: "auto-efficiency", provider: "github-copilot-auto", stopReason: "error" });
	});
});
