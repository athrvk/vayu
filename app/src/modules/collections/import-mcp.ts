/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Import dialog's MCP server tab holds and sends (#3843): the form's state, when it can be
 * sent, and the `POST /import/mcp` body it makes. Beside `ImportMcpForm.tsx`, which draws it; a
 * component file exports components only.
 *
 * The route takes a bearer token and nothing else, so an OAuth connect (#3983) signs in first,
 * through the flow and sign-in registry every OAuth row uses, and sends the access token the
 * engine cached as that bearer token. The token never reaches the collection: the root is given
 * the signed-in config instead (`mcpBatchEntry`).
 */

import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { logError } from "@/errors/error-logger";
import { apiService } from "@/services/api";
import { runInteractiveAuthorization } from "@/services/oauth/authorize";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import {
	discoveredValues,
	oauth2SignInKey,
	withDiscoveredValues,
} from "@/services/oauth/discovery";
import { oauthSignin } from "@/stores/oauth-signin-store";
import type { ImportMcpDiffMatch, ImportMcpRequest, KeyValueItem, OAuth2Config } from "@/types";

export type McpPrimitive = "tools" | "resources" | "prompts";

/** A static bearer token the user typed, or an OAuth sign-in at Connect. */
export type McpAuthChoice = "token" | "oauth";

export interface McpFormState {
	url: string;
	headers: KeyValueItem[];
	/** Sent only while `auth` is `"token"`; kept across a switch so switching back loses nothing. */
	token: string;
	auth: McpAuthChoice;
	include: Record<McpPrimitive, boolean>;
}

/** A function, not a constant: the headers table's blank row carries an id of its own. */
export function emptyMcpForm(): McpFormState {
	return {
		url: "",
		headers: withTrailingBlank([]),
		token: "",
		auth: "token",
		include: { tools: true, resources: false, prompts: false },
	};
}

/** The engine refuses an `include` that leaves nothing in, so the form does not offer to send one. */
export function canConnectMcp(form: McpFormState): boolean {
	return form.url.trim() !== "" && Object.values(form.include).some(Boolean);
}

/**
 * What `POST /import/mcp` is sent. A blank or disabled header row is the table's spare or one the
 * user switched off, so it goes nowhere; a named row with no value is sent as it stands. The
 * engine refuses a header with no name at send and one carrying CR, LF or NUL, not an empty value.
 */
export function mcpImportRequest(form: McpFormState): ImportMcpRequest {
	const headers = form.headers
		.filter((row) => row.enabled && (row.key.trim() !== "" || row.value !== ""))
		.map((row) => ({ name: row.key.trim(), value: row.value }));
	const token = form.auth === "token" ? form.token.trim() : "";
	return {
		url: form.url.trim(),
		...(headers.length > 0 ? { headers } : {}),
		...(token !== "" ? { auth: { mode: "bearer" as const, token } } : {}),
		include: form.include,
	};
}

/**
 * The config a sign-in to the server at @p url starts from: an authorization_code grant with
 * discovery on and every member discovery fills left blank, so the engine fills all of them.
 */
export function mcpOAuthConfig(url: string): OAuth2Config {
	return { ...defaultOAuth2Config(), grantType: "authorization_code", discoverUrl: url };
}

/**
 * Sign in to the server at @p url and answer the config as the sign-in filled it, which is the one
 * its token is cached under. Registered in `oauthSignin` like a token row's sign-in, so a second
 * surface signing in to the same server finds this one running rather than opening another
 * browser tab, and a row releasing the key cannot cancel a sign-in this dialog still holds.
 * Aborting @p signal cancels it. Throws on failure with the message an OAuth row would show.
 */
export async function signInToMcpServer(url: string, signal: AbortSignal): Promise<OAuth2Config> {
	const sent = mcpOAuthConfig(url);
	const key = oauth2SignInKey(sent);
	if (key === null) throw new Error("Type the server's URL to sign in to it.");
	const release = oauthSignin.acquire(key);
	const flow = oauthSignin.begin(key);
	if (!flow) {
		release();
		throw new Error(
			"A sign-in to this server is already running - finish it, then connect again."
		);
	}
	const cancel = () => oauthSignin.cancel(key);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const { resolved } = await runInteractiveAuthorization(sent, flow);
		return resolved ? withDiscoveredValues(sent, discoveredValues(sent, resolved)) : sent;
	} catch (e) {
		throw new Error(humanizeOAuth2Error(e instanceof Error ? e.message : String(e)), {
			cause: e,
		});
	} finally {
		signal.removeEventListener("abort", cancel);
		oauthSignin.end(key, flow);
		release();
	}
}

/**
 * The route's bearer auth for a signed-in @p config: the access token the engine holds for it,
 * refreshed when it has expired. A config whose token is gone and cannot be refreshed is the
 * engine's `409` `oauth2_interactive_required`, which only a new sign-in answers.
 */
export async function mcpOAuthBearer(
	config: OAuth2Config
): Promise<NonNullable<ImportMcpRequest["auth"]>> {
	const { accessToken } = await apiService.fetchOAuth2Token({ config });
	return { mode: "bearer", token: accessToken };
}

/**
 * The collections an earlier import of this server built, compared with what it lists now (#3842).
 * Never throws: the comparison is a courtesy beside an import that does not need it, so a failure
 * reads as "nothing to compare" and is logged, not shown. A cancel is no failure and is not logged.
 */
export async function existingMcpImports(
	request: ImportMcpRequest,
	signal: AbortSignal
): Promise<ImportMcpDiffMatch[]> {
	try {
		return (await apiService.importMcpDiff(request, { signal })).matches;
	} catch (e) {
		if (!signal.aborted) {
			logError(e as Error, "low", { component: "renderer", action: "import-mcp-diff" });
		}
		return [];
	}
}
