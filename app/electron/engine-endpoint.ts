/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the engine listens for this session: the one main-process reader of
 * the port (#2118).
 *
 * The sidecar picks a port from `ENGINE_PORT_CANDIDATES` on its first start and
 * keeps it, and `fixEnginePort` is how that choice reaches everything else. It
 * is fixed once because the renderer is told the port once, as a command-line
 * argument of the window's renderer process, and cannot follow a move. Until it
 * is fixed, the default port is the answer.
 *
 * Kept free of Electron: `renderer-csp.ts` reads the candidate origins from the
 * Vite config.
 */

import { ENGINE_HOST, ENGINE_PORT, ENGINE_PORT_CANDIDATES } from "./constants.js";

/** The engine's origin on `port`, spelled exactly as the renderer addresses it. */
export function engineOriginFor(port: number): string {
	return `http://${ENGINE_HOST}:${port}`;
}

/** Every origin the engine may have this session, for what is fixed at build or install time. */
export const ENGINE_CANDIDATE_ORIGINS: readonly string[] =
	ENGINE_PORT_CANDIDATES.map(engineOriginFor);

let port = ENGINE_PORT;
let fixed = false;
let markFixed!: () => void;
const fixedSignal = new Promise<void>((resolve) => {
	markFixed = resolve;
});

/** The port the engine uses this session. */
export function enginePort(): number {
	return port;
}

/** The engine's origin this session, e.g. `http://127.0.0.1:9876`. */
export function engineOrigin(): string {
	return engineOriginFor(port);
}

/**
 * Record the session's port. Refuses a port outside the candidates, which the
 * CSP and the Origin bridge would not let the renderer reach, and a second,
 * different port, which the renderer would never hear about.
 */
export function fixEnginePort(chosen: number): void {
	if (!ENGINE_PORT_CANDIDATES.includes(chosen)) {
		throw new Error(
			`Engine port ${chosen} is not one of the candidates (${ENGINE_PORT_CANDIDATES.join(", ")})`
		);
	}
	if (fixed && chosen !== port) {
		throw new Error(
			`Engine port is already fixed at ${port} for this session; refused ${chosen}`
		);
	}
	port = chosen;
	fixed = true;
	markFixed();
}

/** Settles once `fixEnginePort` has run. */
export function enginePortFixed(): Promise<void> {
	return fixedSignal;
}
