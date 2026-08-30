#!/usr/bin/env node
/**
 * Measure the renderer bundle, cold-start time and (Windows only) the
 * tasklist-spawn cost of the built Electron app.
 *
 * Written for `.github/workflows/perf-measure.yml` (issue #1162), which runs
 * this after `pnpm run electron:compile && pnpm run build` in `app/`. Output
 * is JSON matching the exact shape `scripts/perf/summarize.py`'s `app_rows()`
 * reads - that function is the contract, this script is what fills it.
 *
 * Three independent measurements, none of which needs the other two to run:
 *
 *   - bundle: reads `app/dist/index.html` for the entry module chunk Vite
 *     wrote (Rolldown hashes the name, so it can only be discovered by
 *     parsing the HTML, never hardcoded) and totals `app/dist`.
 *   - startup: runs `startup-harness.cjs` under Electron 3 times empty and 3
 *     times holding the built renderer, and reports both medians plus the
 *     delta between them - the renderer module graph's cost. Read that file's
 *     header for why this is a harness rather than the real app, and for what
 *     the number therefore does not include.
 *   - tasklistSpawn: on Windows only, times the synchronous `tasklist` spawn
 *     `app/electron/sidecar.ts` pays on every boot to verify an adopted
 *     engine's PID - issue #1148's missing number.
 *
 * Deliberately does not:
 *   - Measure a packaged installer, or the real app's end-to-end cold start.
 *     Both need electron-builder in this workflow; filed separately.
 *   - Retry a failed launch. A flaky Electron launch on a shared runner is
 *     recorded as `"method": "unavailable"` with the actual reason in `note`,
 *     not smoothed over by trying again.
 *   - Add `--no-sandbox` or any other flag to make a failing launch pass. A
 *     launch failure is a real finding about that environment, not something
 *     to work around.
 *
 * Stdlib only, no dependencies - same reasoning as `measure_engine.py`.
 *
 * Usage:
 *   node scripts/perf/measure-app.mjs --out perf-app.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// Must match startup-harness.cjs's HARNESS_MARKER. Both files are in this
// directory and change together; a rename that missed one would time out every
// launch and be reported as an unavailable startup leg rather than a silent
// zero.
const HARNESS_MARKER = "[perf] harness";
const HARNESS_SCRIPT = "scripts/perf/startup-harness.cjs";

const STARTUP_LAUNCH_COUNT = 3;
const LAUNCH_TIMEOUT_MS = 90_000;
// Same grace the sidecar itself gives the engine before SIGKILL
// (ENGINE_GRACEFUL_EXIT_TIMEOUT_MS in app/electron/constants.ts).
const TERMINATE_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 20;
const TASKLIST_ITERATIONS = 20;

function fail(message) {
	console.error(`[perf] ${message}`);
	process.exit(2);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// --------------------------------------------------------------------------
// (a) bundle
// --------------------------------------------------------------------------

/** Find the entry `<script type="module" src="...">` in index.html's markup. */
function findEntryModuleSrc(html) {
	const scriptTagRe = /<script\b([^>]*)>/gi;
	let match;
	while ((match = scriptTagRe.exec(html)) !== null) {
		const attrs = match[1];
		if (!/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
		const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
		if (srcMatch) return srcMatch[1];
	}
	return null;
}

/** `index.html`'s script src, resolved against `app/dist` (base is "./"). */
function resolveDistAsset(distDir, src) {
	const withoutQuery = src.split(/[?#]/)[0];
	const relative = withoutQuery.replace(/^\.?\//, "");
	return path.join(distDir, relative);
}

/** Total bytes and file count of everything under `dir`, recursively. */
function walkDir(dir) {
	let totalBytes = 0;
	let fileCount = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				fileCount += 1;
				totalBytes += statSync(full).size;
			}
		}
	}
	return { totalBytes, fileCount };
}

function measureBundle(repoRoot) {
	const distDir = path.join(repoRoot, "app", "dist");
	const indexPath = path.join(distDir, "index.html");

	if (!existsSync(indexPath)) {
		fail(
			`${indexPath} not found - build the renderer first (\`pnpm run build\` in app/) ` +
				`before measuring the bundle.`
		);
	}

	const html = readFileSync(indexPath, "utf8");
	const entrySrc = findEntryModuleSrc(html);
	if (!entrySrc) {
		fail(`no <script type="module" src="..."> entry chunk found in ${indexPath}`);
	}

	const entryPath = resolveDistAsset(distDir, entrySrc);
	if (!existsSync(entryPath)) {
		fail(`entry chunk named by ${indexPath} does not exist on disk: ${entryPath}`);
	}

	const entryChunkBytes = statSync(entryPath).size;
	const { totalBytes, fileCount } = walkDir(distDir);

	return {
		entryChunkName: path.basename(entryPath),
		entryChunkBytes,
		totalDistBytes: totalBytes,
		fileCount,
	};
}

// --------------------------------------------------------------------------
// (b) startup
// --------------------------------------------------------------------------

/**
 * The local Electron executable.
 *
 * Resolved through the `electron` package, whose main export is the absolute
 * path to the binary, rather than through `app/node_modules/.bin/electron`.
 * The `.bin` shim on Windows is `electron.cmd`, and since Node's fix for
 * CVE-2024-27980 `child_process.spawn` refuses to run a `.cmd` without
 * `shell: true` - so the shim path would have failed on the one runner whose
 * numbers this workflow exists to get. The package export is a real
 * executable (`electron.exe` there), which spawn takes directly.
 */
function resolveElectronBinary(repoRoot) {
	const requireFromApp = createRequire(path.join(repoRoot, "app", "package.json"));
	try {
		return requireFromApp("electron");
	} catch {
		return null;
	}
}

/** Ask nicely, then insist - and wait for the exit either way. */
async function terminateAndWait(child, exited) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const settledInTime = await Promise.race([
		exited.then(() => true),
		sleep(TERMINATE_GRACE_MS).then(() => false),
	]);
	if (!settledInTime && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
	await exited;
}

/**
 * Launch the built app once, watch stdout for the startup marker, and tear
 * the process down before returning either way.
 *
 * Resolves to `{ ok: true, readyToShowMs }` or `{ ok: false, reason }` -
 * never rejects and never throws, so a bad launch is data, not an exception.
 */
async function launchOnce(electronBin, repoRoot, harnessArgs) {
	const child = spawn(electronBin, [HARNESS_SCRIPT, ...harnessArgs], {
		cwd: repoRoot,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const stderrTail = [];
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			stderrTail.push(line);
			if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
		}
	});

	const exited = new Promise((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	let spawnError = null;
	child.on("error", (err) => {
		spawnError = err.message;
	});

	const markerFound = new Promise((resolve) => {
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			let newlineAt;
			while ((newlineAt = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newlineAt);
				buffered = buffered.slice(newlineAt + 1);
				const markerAt = line.indexOf(HARNESS_MARKER);
				if (markerAt === -1) continue;
				try {
					const payload = JSON.parse(line.slice(markerAt + HARNESS_MARKER.length).trim());
					if (typeof payload.readyToShowMs === "number") {
						resolve({ ok: true, readyToShowMs: payload.readyToShowMs });
						return;
					}
				} catch {
					// Malformed marker line - keep reading rather than failing on it;
					// the timeout or exit below is the real backstop.
				}
			}
		});
	});

	const exitedAsFailure = exited.then(({ code, signal }) => ({
		ok: false,
		reason: spawnError
			? `failed to spawn: ${spawnError}`
			: `exited (code ${code}, signal ${signal}) before logging the startup marker`,
	}));
	const timedOut = sleep(LAUNCH_TIMEOUT_MS).then(() => ({
		ok: false,
		reason: `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for the startup marker`,
	}));

	let result = await Promise.race([markerFound, exitedAsFailure, timedOut]);
	if (!result.ok && stderrTail.length > 0) {
		result = { ...result, reason: `${result.reason} - stderr tail: ${stderrTail.join(" | ")}` };
	}

	await terminateAndWait(child, exited);
	return result;
}

/** Run the harness `STARTUP_LAUNCH_COUNT` times in one mode. */
async function timeHarness(electronBin, repoRoot, harnessArgs, label) {
	const launches = [];
	for (let i = 0; i < STARTUP_LAUNCH_COUNT; i++) {
		const result = await launchOnce(electronBin, repoRoot, harnessArgs);
		if (!result.ok) {
			return { ok: false, reason: `${label} launch ${i + 1}/${STARTUP_LAUNCH_COUNT}: ${result.reason}` };
		}
		launches.push(result.readyToShowMs);
	}
	return { ok: true, launches, medianMs: median(launches) };
}

/**
 * Time an empty window, then the same window holding the built renderer.
 *
 * The delta is what the renderer's module graph costs, which is the sweep's
 * method and the number #1146/#1147 move. The absolute renderer figure is not a
 * user's cold-start time - it excludes everything the real main process does
 * before a window exists - so it is reported alongside the baseline rather than
 * on its own, and `method` says which measurement this is.
 */
async function measureStartup(repoRoot) {
	const unavailable = (note) => ({
		method: "unavailable",
		launches: [],
		medianMs: null,
		blankMedianMs: null,
		rendererGraphMs: null,
		note,
	});

	const electronBin = resolveElectronBinary(repoRoot);
	if (!electronBin || !existsSync(electronBin)) {
		return unavailable(
			`electron binary not resolvable from app/ (${electronBin ?? "package not found"}) - was \`pnpm install\` run there?`
		);
	}

	const entry = path.join(repoRoot, "app", "dist", "index.html");
	const blank = await timeHarness(electronBin, repoRoot, ["--mode", "blank"], "blank");
	if (!blank.ok) return unavailable(blank.reason);

	const renderer = await timeHarness(
		electronBin,
		repoRoot,
		["--mode", "renderer", "--entry", entry],
		"renderer"
	);
	if (!renderer.ok) return unavailable(renderer.reason);

	return {
		method: "renderer-graph-delta",
		launches: renderer.launches,
		medianMs: renderer.medianMs,
		blankMedianMs: blank.medianMs,
		rendererGraphMs: renderer.medianMs - blank.medianMs,
		note: null,
	};
}

// --------------------------------------------------------------------------
// (c) tasklistSpawn - Windows only
// --------------------------------------------------------------------------

/**
 * Time the exact `tasklist` spawn `app/electron/sidecar.ts` (lines ~120-122)
 * makes to verify an adopted engine's PID. Mirrored command and options, this
 * process's own pid standing in for the engine's - the number that matters is
 * what a synchronous `execSync` spawn costs on this machine, not which PID it
 * asks about.
 */
function measureTasklistSpawn() {
	if (process.platform !== "win32") return null;

	const timings = [];
	for (let i = 0; i < TASKLIST_ITERATIONS; i++) {
		const started = performance.now();
		execSync(`tasklist /FI "PID eq ${process.pid}" /FO CSV /NH`, {
			encoding: "utf-8",
		});
		timings.push(performance.now() - started);
	}

	return {
		iterations: TASKLIST_ITERATIONS,
		medianMs: median(timings),
		meanMs: timings.reduce((sum, t) => sum + t, 0) / timings.length,
	};
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
	let out = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") out = argv[++i];
	}
	if (!out) {
		console.error("[perf] usage: node scripts/perf/measure-app.mjs --out <path>");
		process.exit(2);
	}
	return { out };
}

async function main() {
	const { out } = parseArgs(process.argv.slice(2));
	// cwd is the repo root - see the workflow step that invokes this script.
	const repoRoot = process.cwd();

	const bundle = measureBundle(repoRoot);
	const startup = await measureStartup(repoRoot);
	const tasklistSpawn = measureTasklistSpawn();

	const result = {
		schema: 1,
		os: process.platform,
		bundle,
		startup,
		tasklistSpawn,
	};

	writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
	console.log(`[perf] wrote ${out}`);
}

main().catch((err) => {
	console.error(`[perf] measurement failed: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
