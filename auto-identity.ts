import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

export const AUTO_PROVIDER = "github-copilot-auto";
export const FUSION_PROVIDER = "github-copilot-fusion";
export const COPILOT_PROVIDER = "github-copilot";

// Non-secret provenance survives JSONL persistence. Never store the session token.
type RoutedMessage = AssistantMessage & {
	copilotAutoRoute?: { model: string; api: Api };
	copilotFusionRoute?: { model: string; api: Api };
};

function asRoutedMessage(message: AssistantMessage, selected: Model<Api>, provider: string, routeKey: "copilotAutoRoute" | "copilotFusionRoute"): RoutedMessage {
	return {
		...message,
		provider,
		model: selected.id,
		...(message.provider === COPILOT_PROVIDER
			? {
				responseModel: message.responseModel ?? message.model,
				[routeKey]: { model: message.model, api: message.api },
			}
			: {}),
	};
}

function asRoutedEvent(event: AssistantMessageEvent, selected: Model<Api>, provider: string, routeKey: "copilotAutoRoute" | "copilotFusionRoute"): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: asRoutedMessage(event.message, selected, provider, routeKey) };
	if (event.type === "error") return { ...event, error: asRoutedMessage(event.error, selected, provider, routeKey) };
	return { ...event, partial: asRoutedMessage(event.partial, selected, provider, routeKey) };
}

/** Pi restores the active model from assistant messages, including errors. */
export function asAutoEvent(event: AssistantMessageEvent, selected: Model<Api>): AssistantMessageEvent {
	return asRoutedEvent(event, selected, AUTO_PROVIDER, "copilotAutoRoute");
}

/** Preserve the opted-in Fusion model identity while retaining concrete producer provenance. */
export function asFusionEvent(event: AssistantMessageEvent, selected: Model<Api>): AssistantMessageEvent {
	return asRoutedEvent(event, selected, FUSION_PROVIDER, "copilotFusionRoute");
}

function restoreRoutedContext(context: Context, provider: string, routeKey: "copilotAutoRoute" | "copilotFusionRoute"): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant" || message.provider !== provider) return message;
			const routed = message as RoutedMessage;
			const route = routed[routeKey];
			const { [routeKey]: _route, ...original } = routed;
			if (!route || typeof route.model !== "string" || !route.model || typeof route.api !== "string") return message;
			return { ...original, provider: COPILOT_PROVIDER, model: route.model, api: route.api };
		}),
	};
}

/**
 * Restore the producing model before pi-ai's cross-model history conversion.
 * Otherwise same-model reasoning signatures / Responses item IDs get stripped
 * because saved Auto messages look like they came from another provider.
 * Restore the original route, NOT the current target, so genuine model switches
 * still receive pi-ai's normal cross-model conversion. Leave legacy history alone.
 */
export function restoreAutoContext(context: Context): Context {
	return restoreRoutedContext(context, AUTO_PROVIDER, "copilotAutoRoute");
}

/** Restore concrete Fusion phase/model provenance without changing the saved Fusion selection. */
export function restoreFusionContext(context: Context): Context {
	return restoreRoutedContext(context, FUSION_PROVIDER, "copilotFusionRoute");
}
