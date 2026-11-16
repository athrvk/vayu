/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useClientSettingsStore } from "@/stores/client-settings-store";
import { approveEndpoint, endpointOrigin, isEndpointApproved } from "./approved-endpoints";

const approved = () => useClientSettingsStore.getState().approvedEndpoints;

beforeEach(() => useClientSettingsStore.setState({ approvedEndpoints: [] }));

describe("endpointOrigin", () => {
	it.each([
		["https://api.test/gql?x=1#f", "https://api.test"],
		["HTTPS://API.Test:443/gql", "https://api.test"],
		["http://localhost:8080/graphql", "http://localhost:8080"],
		["http://localhost/graphql", "http://localhost"],
	])("reads %s as %s", (url, origin) => {
		expect(endpointOrigin(url)).toBe(origin);
	});

	it.each([
		["an unresolved variable in the host", "https://{{host}}/gql"],
		["a bare variable", "{{base}}/gql"],
		["a path with no scheme", "/gql"],
		["a scheme the engine does not send over", "ftp://api.test/gql"],
		["nothing", ""],
	])("names no origin for %s", (_, url) => {
		expect(endpointOrigin(url)).toBeNull();
	});

	it("tells another port, scheme or host apart", () => {
		expect(endpointOrigin("https://api.test:8443/")).not.toBe(
			endpointOrigin("https://api.test/")
		);
		expect(endpointOrigin("http://api.test/")).not.toBe(endpointOrigin("https://api.test/"));
		expect(endpointOrigin("https://api.test.evil/")).not.toBe(
			endpointOrigin("https://api.test/")
		);
	});
});

describe("approving an endpoint", () => {
	it("approves every URL on the origin and no other", () => {
		approveEndpoint("https://api.test/one");
		expect(approved()).toEqual(["https://api.test"]);
		expect(isEndpointApproved("https://api.test/two?q=1")).toBe(true);
		expect(isEndpointApproved("https://api.test:8443/one")).toBe(false);
		expect(isEndpointApproved("http://api.test/one")).toBe(false);
	});

	it("approves nothing for a URL that names no origin", () => {
		approveEndpoint("https://{{host}}/gql");
		approveEndpoint("");
		expect(approved()).toEqual([]);
		expect(isEndpointApproved("https://{{host}}/gql")).toBe(false);
	});
});
