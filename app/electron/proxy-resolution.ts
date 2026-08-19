/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * System proxy resolution - the bridge between two networking stacks (#708).
 *
 * Vayu talks to the network twice over and the two halves cannot see each
 * other: the Electron shell rides Chromium, which reads the operating system's
 * proxy configuration (and its PAC script) on its own, while every request the
 * user actually sends goes out through the engine's libcurl, which reads none
 * of it. That is why "the app loads fine and every request fails" is the shape
 * a corporate proxy takes.
 *
 * The main process is the only place both are visible, so it is where the
 * bridge lives: Chromium resolves, and the answer is written into the engine's
 * `proxySystemUrl` setting, which `proxyMode: system` reads. Nothing is cached
 * here - the setting *is* the state, visible in Settings, which is the
 * disclosure rule this epic is built on.
 *
 * **PAC is resolved once, not per request.** A PAC script answers per URL and
 * the engine cannot call back into Chromium for every transfer, so the
 * resolution is made against one probe URL and that answer applies engine-wide.
 * A configuration that returns different proxies for different URLs needs
 * `manual`. Stated in the setting's own description too, because a limitation
 * only the source knows is a limitation nobody knows.
 */

import { ENGINE_HOST, ENGINE_PORT } from "./constants.js";

/**
 * The URL Chromium is asked about.
 *
 * https, and a public host, because that is the shape of the traffic this
 * matters for: a PAC script that sends internal hosts direct and everything
 * else through a gateway must answer with the gateway. Never contacted - the
 * resolution is local - so this makes no request to anybody.
 */
export const PROXY_PROBE_URL = "https://api.example.com/";

/** The engine setting this module owns end to end. */
export const SYSTEM_PROXY_KEY = "proxySystemUrl";

/**
 * Chromium's proxy scheme words, mapped to the URL scheme libcurl takes.
 *
 * `SOCKS` on its own is Chromium's spelling of SOCKS4, not a family name - the
 * mapping is one of the two places where guessing would send traffic through
 * the wrong protocol version and be reported as a connection failure.
 */
const SCHEME_BY_KEYWORD: Readonly<Record<string, string>> = {
	PROXY: "http",
	HTTP: "http",
	HTTPS: "https",
	SOCKS: "socks4",
	SOCKS4: "socks4",
	SOCKS5: "socks5",
};

/**
 * Turn Chromium's PAC-style answer into the curl-shaped URL the engine stores.
 *
 * `session.resolveProxy` answers in PAC syntax: `DIRECT`, `PROXY host:port`, or
 * a `;`-separated fallback chain (`PROXY a:1; PROXY b:2; DIRECT`). Only the
 * first usable entry is taken, because the engine applies one proxy and a
 * fallback chain it cannot walk would be a promise nothing keeps - a user whose
 * first proxy is down gets the failure rather than a silent second hop, which
 * is the honest half of the two.
 *
 * Returns `""` for a direct configuration and for anything unparseable. Empty
 * is a real answer here ("this machine proxies nothing"), not an error: it is
 * what clears the setting so `system` mode stops routing through a proxy that
 * is no longer configured.
 */
export function systemProxyUrl(resolved: string): string {
	for (const entry of resolved.split(";")) {
		const parts = entry.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) continue;

		const keyword = parts[0].toUpperCase();
		if (keyword === "DIRECT") return "";

		const scheme = SCHEME_BY_KEYWORD[keyword];
		const authority = parts[1];
		// An entry naming a scheme we cannot map, or no host at all, is skipped
		// rather than guessed at - the chain may still hold one we understand.
		if (!scheme || !authority) continue;
		// A host with no port would be curl's default proxy port (1080), which
		// is a different proxy from the one the OS named. Refuse the guess.
		if (!/^\S+:\d+$/.test(authority)) continue;

		return `${scheme}://${authority}`;
	}
	return "";
}

/** The I/O this module performs, injected so the logic is testable without Electron. */
export interface ProxyResolutionSystem {
	/** `session.resolveProxy` - Chromium's answer for one URL, in PAC syntax. */
	resolveProxy: (url: string) => Promise<string>;
	/** The engine's current value for a config key, or "" when it cannot be read. */
	readSetting: (key: string) => Promise<string>;
	/** Write one config key to the engine. */
	writeSetting: (key: string, value: string) => Promise<void>;
	/** Where a failure goes. Separate so a test can read it. */
	log: (message: string) => void;
}

const engineBase = () => `http://${ENGINE_HOST}:${ENGINE_PORT}`;

export const defaultProxyResolutionSystem: ProxyResolutionSystem = {
	// Filled in by `installProxyResolution`, which is the only place a real
	// Electron session exists. Resolving nothing is the correct answer for a
	// process with no session: it leaves the setting alone.
	resolveProxy: async () => "DIRECT",
	readSetting: async (key) => {
		const response = await fetch(`${engineBase()}/config`);
		if (!response.ok) throw new Error(`config responded ${response.status}`);
		const config = (await response.json()) as { entries?: { key?: string; value?: string }[] };
		return config?.entries?.find((entry) => entry.key === key)?.value ?? "";
	},
	writeSetting: async (key, value) => {
		const response = await fetch(`${engineBase()}/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entries: { [key]: value } }),
		});
		if (!response.ok) throw new Error(`config responded ${response.status}`);
	},
	log: (message) => console.error(message),
};

/**
 * Resolve the OS proxy and push it to the engine when it has changed.
 *
 * Idempotent and safe to call as often as anything wants to: a resolution that
 * matches what the engine already holds writes nothing, so the network-change
 * listeners can be as eager as they like without a settings write per event.
 *
 * Never throws. Every failure mode here - an engine that has not finished
 * starting, a session that cannot resolve - leaves the stored value alone,
 * which is the safe direction: the last known-good proxy keeps working, and
 * `system` mode's own fallback covers the case where there never was one.
 *
 * @returns the resolved proxy URL, or `""` for a direct configuration. `null`
 *          when the resolution could not be made at all - distinct from `""`,
 *          because "no proxy" and "could not ask" must not clear the same
 *          setting.
 */
export async function refreshSystemProxy(
	system: ProxyResolutionSystem = defaultProxyResolutionSystem
): Promise<string | null> {
	let resolved: string;
	try {
		resolved = systemProxyUrl(await system.resolveProxy(PROXY_PROBE_URL));
	} catch (error) {
		system.log(`Could not resolve the system proxy: ${String(error)}`);
		return null;
	}

	try {
		const stored = await system.readSetting(SYSTEM_PROXY_KEY);
		if (stored === resolved) return resolved;
		await system.writeSetting(SYSTEM_PROXY_KEY, resolved);
	} catch (error) {
		// The engine could not be read or written. Reported and dropped: the
		// user is about to notice a great deal more than a stale proxy row, and
		// failing startup over a diagnostic write would be the worse trade.
		system.log(`Could not store the resolved system proxy: ${String(error)}`);
		return null;
	}
	return resolved;
}
