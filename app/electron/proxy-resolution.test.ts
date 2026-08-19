/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * System proxy resolution (issue #708).
 *
 * Two things are worth pinning here, and neither is Electron's:
 *
 * 1. **The PAC-to-curl translation.** Chromium answers in PAC syntax and
 *    libcurl takes a URL; getting the scheme wrong sends traffic through the
 *    wrong protocol version and reports it as a connection failure.
 * 2. **When the engine is written to.** An unchanged answer must write nothing
 *    (the listeners are deliberately eager), and a resolution that could not be
 *    made must not clear a good stored value.
 */

import { describe, expect, it, vi } from "vitest";

import {
	PROXY_PROBE_URL,
	SYSTEM_PROXY_KEY,
	refreshSystemProxy,
	systemProxyUrl,
	type ProxyResolutionSystem,
} from "./proxy-resolution";

describe("translating Chromium's answer", () => {
	it("maps each proxy kind to the scheme libcurl takes", () => {
		expect(systemProxyUrl("PROXY corp.example:8080")).toBe("http://corp.example:8080");
		expect(systemProxyUrl("HTTPS corp.example:8443")).toBe("https://corp.example:8443");
		expect(systemProxyUrl("SOCKS5 corp.example:1080")).toBe("socks5://corp.example:1080");
	});

	it("reads a bare SOCKS as SOCKS4, which is what Chromium means by it", () => {
		// Not a family name: Chromium spells SOCKS4 as `SOCKS`, and reading it
		// as SOCKS5 would negotiate a protocol the proxy does not speak.
		expect(systemProxyUrl("SOCKS corp.example:1080")).toBe("socks4://corp.example:1080");
	});

	it("reports a direct configuration as no proxy", () => {
		// "" is a real answer - it is what clears the setting when a machine
		// stops proxying - and must not be confused with a failure.
		expect(systemProxyUrl("DIRECT")).toBe("");
	});

	it("takes the first usable entry of a fallback chain", () => {
		// The engine applies one proxy. A chain it cannot walk would be a
		// promise nothing keeps, so the first entry is the answer.
		expect(systemProxyUrl("PROXY first.example:8080; PROXY second.example:8080; DIRECT")).toBe(
			"http://first.example:8080"
		);
	});

	it("stops at a DIRECT that comes first", () => {
		expect(systemProxyUrl("DIRECT; PROXY corp.example:8080")).toBe("");
	});

	it("skips an entry it cannot map and keeps reading", () => {
		expect(systemProxyUrl("QUIC corp.example:443; PROXY corp.example:8080")).toBe(
			"http://corp.example:8080"
		);
	});

	it("refuses a host with no port rather than guessing one", () => {
		// curl's default proxy port is 1080, which is a different proxy from the
		// one the OS named. Guessing here would route traffic somewhere nobody
		// configured.
		expect(systemProxyUrl("PROXY corp.example")).toBe("");
	});

	it("answers nothing for text it cannot read at all", () => {
		expect(systemProxyUrl("")).toBe("");
		expect(systemProxyUrl("   ")).toBe("");
	});
});

/** A resolver over fakes, with the calls it made recorded. */
function harness(overrides: Partial<ProxyResolutionSystem> = {}) {
	const writes: Array<[string, string]> = [];
	const logs: string[] = [];
	const system: ProxyResolutionSystem = {
		resolveProxy: vi.fn(async () => "PROXY corp.example:8080"),
		readSetting: vi.fn(async () => ""),
		writeSetting: vi.fn(async (key: string, value: string) => {
			writes.push([key, value]);
		}),
		log: (message) => logs.push(message),
		...overrides,
	};
	return { system, writes, logs };
}

describe("pushing the resolved proxy to the engine", () => {
	it("writes the translated URL when it differs from what is stored", async () => {
		const { system, writes } = harness();

		await expect(refreshSystemProxy(system)).resolves.toBe("http://corp.example:8080");
		expect(writes).toEqual([[SYSTEM_PROXY_KEY, "http://corp.example:8080"]]);
		expect(system.resolveProxy).toHaveBeenCalledWith(PROXY_PROBE_URL);
	});

	it("writes nothing when the answer has not moved", async () => {
		// The listeners are deliberately eager - startup, wake, `online`, and
		// every visit to the network settings - so an unchanged answer costing a
		// settings write would make this a write per event.
		const { system, writes } = harness({
			readSetting: vi.fn(async () => "http://corp.example:8080"),
		});

		await expect(refreshSystemProxy(system)).resolves.toBe("http://corp.example:8080");
		expect(writes).toEqual([]);
	});

	it("clears the setting when the machine stops proxying", async () => {
		// The half that makes `system` mode honest in both directions: a laptop
		// that left the office must stop routing through the office proxy.
		const { system, writes } = harness({
			resolveProxy: vi.fn(async () => "DIRECT"),
			readSetting: vi.fn(async () => "http://corp.example:8080"),
		});

		await expect(refreshSystemProxy(system)).resolves.toBe("");
		expect(writes).toEqual([[SYSTEM_PROXY_KEY, ""]]);
	});

	it("leaves the stored value alone when the OS cannot be asked", async () => {
		// Distinct from "no proxy": the last known-good value keeps working, and
		// the null return says the caller has nothing new to act on.
		const { system, writes, logs } = harness({
			resolveProxy: vi.fn(async () => {
				throw new Error("no session");
			}),
			readSetting: vi.fn(async () => "http://corp.example:8080"),
		});

		await expect(refreshSystemProxy(system)).resolves.toBeNull();
		expect(writes).toEqual([]);
		expect(logs.join(" ")).toContain("no session");
	});

	it("never throws when the engine is not answering yet", async () => {
		// It runs at startup, right after the engine is launched. Failing there
		// would fail app startup over a diagnostic write.
		const { system, logs } = harness({
			readSetting: vi.fn(async () => {
				throw new Error("config responded 503");
			}),
		});

		await expect(refreshSystemProxy(system)).resolves.toBeNull();
		expect(logs.join(" ")).toContain("503");
	});
});
