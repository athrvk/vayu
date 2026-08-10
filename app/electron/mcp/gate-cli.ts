/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file gate-cli.ts
 * @brief Headless CI gate: start a load run against a **running** engine, wait
 *        for it, print the per-budget verdict, and exit non-zero when the run
 *        missed a budget. Run: `node dist-electron/mcp/gate-cli.js [flags]`.
 *
 *        Sibling of `cli.ts` (the stdio MCP server) and built the same way - a
 *        standalone Node entry under `electron/`, emitted to `dist-electron` by
 *        `tsconfig.node.json`, no Electron runtime involved.
 *
 *        **The gate does not manage the engine.** Lifecycle stays with the app
 *        and with whatever CI step starts `vayu-engine`; `--engine-url` is the
 *        only coupling. That keeps the platform-specific spawn/lock logic the
 *        Electron main owns out of a CLI that has no business owning it.
 *
 *        stdout carries the verdict (or `--json`'s raw report) so a pipeline
 *        can capture it; everything else - progress, warnings, errors - is
 *        stderr. All the logic lives in `gate.ts`, so this file holds only what
 *        a test cannot: argv, the clock, the streams and the exit code.
 */

import { EngineClient } from "./engine-client.js";
import {
	EXIT_OPERATIONAL,
	GateHelpRequested,
	gateErrorMessage,
	parseGateArgs,
	runGate,
} from "./gate.js";

async function main(): Promise<number> {
	let options;
	try {
		options = parseGateArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof GateHelpRequested) {
			console.log(err.message);
			return 0;
		}
		console.error(gateErrorMessage(err));
		return EXIT_OPERATIONAL;
	}

	return runGate({
		client: new EngineClient({ baseUrl: options.engineUrl }),
		options,
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	});
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		console.error(gateErrorMessage(err));
		process.exitCode = EXIT_OPERATIONAL;
	}
);
