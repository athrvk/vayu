/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file graphql-schema.tools.ts
 * @brief `get_graphql_schema`: a GraphQL request's schema, introspected through
 *        the engine with the request's own auth and answered as SDL (#2097).
 */

import { z } from "zod";
import { checkComposedTarget, targetPolicyRefusal } from "../safety.js";
import { secretsShape, withheldPointer, withholdRequestUrl } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	engineErrorResult,
	errorResult,
	stringArray,
	structuredResult,
	ToolArgError,
} from "./kit.js";
import { graphqlSdlSchema } from "./output-schemas.js";
import { boundText } from "./inline-body-bounds.js";
import { asMcpSend, composeViaEngine, readAuthArg, resolveEnvironmentId } from "./compose.js";
import {
	authInput,
	collectionIdInput,
	environmentIdInput,
	requestHeadersInput,
} from "./input-schemas.js";
import {
	introspectionPayload,
	MAX_SCHEMA_SDL_BYTES,
	printSdl,
	readIntrospectionAnswer,
	schemaComposeBody,
} from "./graphql-schema.js";

export const GRAPHQL_SCHEMA_TOOLS: McpTool[] = [
	{
		name: "get_graphql_schema",
		category: "read",
		invalidates: [],
		description: (config) =>
			"Read a GraphQL endpoint's schema as SDL, so a query is written against the types the endpoint actually declares. Pass a saved request's `requestId` to compose it exactly as a send of that request would (variables resolved, `inherit` auth walked through its collection), or an endpoint `url` with optional `headers`, `auth`, `collectionId` and `environmentId` for one with no saved request. The standard introspection query is then sent as a POST with that request's own auth and headers; the send is transient, so no run is filed in History, and the schema is fetched live on every call. GUARDED: the composed endpoint's host must be on Vayu's MCP allowlist. " +
			`\`sdl\` is capped at ${MAX_SCHEMA_SDL_BYTES} bytes, with \`sdlTruncated\` and \`sdlBytes\` (the true size) beside it. \`types\` lists every named type the schema declares, whether or not it fits under the cap; pass \`types\` to print only the ones you name, in the order given, which is how a schema past the cap is read in parts - a name the schema does not declare is listed under \`unknownTypes\` rather than failing the call.` +
			withheldPointer(config, "url"),
		annotations: {
			title: "Get a GraphQL request's schema",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			requestId: z
				.string()
				.optional()
				.describe(
					"A saved GraphQL request, the (req_...) of a Vayu reference line. Composed as stored; pass it alone or with `environmentId`."
				),
			url: z
				.string()
				.optional()
				.describe(
					"The GraphQL endpoint (may contain {{variables}}), for one with no saved request. Exclusive with `requestId`."
				),
			collectionId: collectionIdInput,
			environmentId: environmentIdInput,
			headers: requestHeadersInput.describe(
				"Headers to send with `url`, as `{name, value}` lines or a string map. Inline form only."
			),
			auth: authInput.describe(
				"Auth block to send with `url` (e.g. { mode: 'bearer', token: '{{apiToken}}' }); the engine resolves and applies it. Inline form only."
			),
			types: z
				.array(z.string())
				.optional()
				.describe(
					'Print only these named types (e.g. ["Query", "Order"]), in this order. Omit for the whole schema.'
				),
		},
		outputSchema: graphqlSdlSchema,
		handler: async (args, ctx, signal) => {
			const only = stringArray(args, "types");
			const composeBody = schemaComposeBody(args, readAuthArg(args));

			// Gate on the composed URL before any traffic, as run_request does: the
			// stored row or a {{variable}} decides the host, not the arguments.
			let environmentId: string | undefined;
			let composed: Record<string, unknown>;
			try {
				environmentId = await resolveEnvironmentId(args, ctx, signal);
				composed = await composeViaEngine(
					ctx.client,
					{ ...composeBody, environmentId },
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			const url = String(composed.url ?? "");
			const gate = checkComposedTarget(composed, ctx.config, ctx.host);
			if (!gate.ok) return errorResult(gate.error!);

			const payload = await introspectionPayload(composed, environmentId);
			let answer: unknown;
			try {
				answer = await ctx.client.executeRequest(asMcpSend(payload, ctx), signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const refused = targetPolicyRefusal(answer, ctx.host);
			if (refused) return errorResult(refused);
			const read = readIntrospectionAnswer(answer, url);
			if ("error" in read) return errorResult(read.error);

			let printed;
			try {
				printed = await printSdl(read.data, only);
			} catch {
				// graphql's own message inspects the value it refused, which is
				// the endpoint's body.
				return errorResult(
					"The endpoint's answer is not an introspection result - it may not be a GraphQL endpoint."
				);
			}
			const sdl = boundText(printed.sdl, MAX_SCHEMA_SDL_BYTES);
			return structuredResult({
				endpoint: secretsShape(ctx, (value) => withholdRequestUrl(value, composed.auth))(
					composed.url
				),
				fetchedAt: Date.now(),
				sdl: sdl.text,
				sdlTruncated: sdl.truncated,
				sdlBytes: sdl.bytes,
				types: printed.types,
				unknownTypes: printed.unknownTypes,
			});
		},
	},
];
