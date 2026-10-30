/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file mock-server.ts
 * @brief The payload `start_mock_server` sends, and the caveat on its answer.
 */

import { isRecord, requireStr } from "./kit.js";

/**
 * The fields `POST /mock/start` accepts (`parse_mock_start`,
 * engine/src/http/routes/mock_server.cpp). `collectionId` is required and is
 * validated by {@link requireStr} before the body is built; the other four are
 * optional knobs.
 */
const MOCK_SERVER_START_KEYS = ["port", "latencyMs", "errorRatePct", "allowedOrigins"] as const;

/**
 * The start body. `collectionId` always travels; a knob the caller did not name
 * stays absent, for the reason {@link mockIssuerStartPayload} records - the
 * engine reads a present field with a bad value as a 400 rather than falling
 * back to its default.
 *
 * The engine's `latencyMs` ceiling is not restated in the schema (the same
 * division of labour the issuer tools document): it lives in
 * `core/constants.hpp`, an out-of-range value comes back as a 400 naming the
 * bound, and a copy here would refuse values the engine accepts the moment
 * either side moves. `port` and `errorRatePct` are bounded in the schema
 * because their bounds are the *shape* - a port is 0-65535 everywhere and a
 * percentage is 0-100 by definition, not by an engine constant.
 *
 * `allowedOrigins` (#2367) is the first kind: its count and length ceilings are
 * engine constants, and what makes an entry an origin is the engine's
 * `canonical_origin`, so the schema says "array of strings" and the engine's
 * `400` names the entry (`allowedOrigins[1]`) and what is wrong with it. It
 * travels as given, `[]` included - the engine reads that as the default.
 */
export function mockServerStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = { collectionId: requireStr(args, "collectionId") };
	for (const key of MOCK_SERVER_START_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	return payload;
}

/**
 * What a started mock could not serve, or "" when every route has an example
 * and none is shadowed.
 *
 * A mock with routes but no examples answers `501` to each of them, which reads
 * as a broken mock rather than as an empty collection - so the count the engine
 * already reports (`routesWithoutExample`) is turned into a sentence instead of
 * being left for an agent to notice in the JSON. `routeCount: 0` is the sharper
 * case and gets its own line: there is nothing to point a client at.
 * `duplicateRoutes` (#3115) is the other silent one: a request that shares a
 * method and path with another never answers.
 */
export function mockServerCaveat(started: unknown): string {
	if (!isRecord(started)) return "";
	const routes = Number(started.routeCount);
	if (Number.isFinite(routes) && routes === 0) {
		return (
			"\nThis mock serves no routes: the collection has no requests the mock could map. " +
			"Every path answers 404."
		);
	}
	return (
		missingExampleCaveat(routes, Number(started.routesWithoutExample)) +
		duplicateRoutesCaveat(Number(started.duplicateRoutes))
	);
}

function missingExampleCaveat(routes: number, without: number): string {
	if (!Number.isFinite(without) || without <= 0) return "";
	return (
		`\n${without} of ${routes} route(s) have no saved example, and answer 501 rather than a body. ` +
		"Save an example on those requests (or check get_mock_routes for which they are) before pointing a client at them."
	);
}

function duplicateRoutesCaveat(duplicates: number): string {
	if (!Number.isFinite(duplicates) || duplicates <= 0) return "";
	return (
		`\n${duplicates} request(s) share a method and path with another request and never answer: ` +
		"the mock drops the query, so only one request per path is served and the rest show 0 hits. " +
		"get_mock_routes marks each one (shadowed, shadowedBy); give them distinct paths to serve them all."
	);
}
