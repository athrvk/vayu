/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Fetches a GraphQL schema by sending the standard introspection query through
 * the engine (apiService.executeRequest), avoiding CORS and reusing the
 * request's auth headers.
 */

import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema } from "graphql";
import { apiService } from "@/services/api";
import type { ExecuteRequestRequest } from "@/types";

export function buildIntrospectionRequest(
	url: string,
	headers: Record<string, string>
): ExecuteRequestRequest {
	return {
		method: "POST",
		url,
		headers: { ...headers, "Content-Type": "application/json" },
		// The engine expects a structured body ({ mode, content }), not a raw
		// string - content is the serialized JSON the server receives.
		body: { mode: "json", content: JSON.stringify({ query: getIntrospectionQuery() }) },
	};
}

export async function introspectSchema(
	url: string,
	headers: Record<string, string>
): Promise<GraphQLSchema> {
	const res = await apiService.executeRequest(buildIntrospectionRequest(url, headers));
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Introspection failed: HTTP ${res.status}`);
	}
	let parsed: { data?: unknown; errors?: { message: string }[] };
	try {
		parsed = JSON.parse(res.bodyRaw);
	} catch {
		throw new Error("Introspection response was not valid JSON");
	}
	if (parsed.errors?.length) {
		throw new Error(parsed.errors.map((e) => e.message).join("; "));
	}
	if (!parsed.data) {
		throw new Error("Introspection response had no data");
	}
	return buildClientSchema(parsed.data as Parameters<typeof buildClientSchema>[0]);
}
