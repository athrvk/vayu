#!/usr/bin/env node
/**
 * Measure the renderer bundle, cold-start time and (Windows only) the
 * tasklist-spawn cost of the built Electron app.
 *
 * Written for `.github/workflows/perf-measure.yml` (issue #1162), which runs
 * this after `pnpm run build` in `app/`. Output is JSON matching the exact
 * shape `scripts/perf/summarize.py`'s `app_rows()` reads - that function is
 * the contract, this script is what fills it.
 *
 * Four independent measurements, none of which needs the others to run:
 *
 *   - bundle: reads `app/dist/index.html` for the entry module chunk Vite
 *     wrote (Rolldown hashes the name, so it can only be discovered by
 *     parsing the HTML, never hardcoded) and totals `app/dist`.
 *   - packagedStartup: launches the packaged app itself, 3 times, and reports
 *     the median time from process start to `ready-to-show` - a user's cold
 *     start, the main process's own work included (#1165). Only when
 *     `--packaged-dir` names an electron-builder output directory; the
 *     workflow packages first and passes it.
 *   - startup: runs `startup-harness.cjs` under Electron 3 times empty and 3
 *     times holding the built renderer, and reports both medians plus the
 *     delta between them - the renderer module graph's cost. It measures a
 *     window of its own, not the app, and stays because it is the number
 *     #1146/#1147's bundle work moves and the one this program's history is
 *     recorded in; read that file's header for what it therefore excludes.
 *   - tasklistSpawn: on Windows only, times the synchronous `tasklist` spawn
 *     `app/electron/sidecar.ts` pays on every boot to verify an adopted
 *     engine's PID - issue #1148's missing number.
 *
 * Deliberately does not:
 *   - Measure an installer's own cost (NSIS, dmg, AppImage's FUSE mount). The
 *     packaged leg measures an unpacked `--dir` build, which is the same asar,
 *     the same `resources/bin` engine and the same main process a user
 *     installs, without paying three runners for three installer formats.
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
 *   node scripts/perf/measure-app.mjs --out perf-app.json --packaged-dir app/release
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";

// Must match startup-harness.cjs's HARNESS_MARKER. Both files are in this
// directory and change together; a rename that missed one would time out every
// launch and be reported as an unavailable startup leg rather than a silent
// zero.
const HARNESS_MARKER = "[perf] harness";
const HARNESS_SCRIPT = "scripts/perf/startup-harness.cjs";

// Must match STARTUP_MARKER in `app/electron/startup-probe.ts`, which prints
// the line this waits for. These two cannot share a constant - one is compiled
// into the main process, the other is this standalone script - so
// `app/electron/startup-probe.test.ts` compares them, and this file is routed
// to that suite through ROOT_READING_GUARDS.
const PACKAGED_MARKER = "[vayu] startup";
// What the packaged app asks for that line with.
const PACKAGED_MEASURE_ENV = "VAYU_MEASURE_STARTUP";
// ENGINE_PORT in `app/electron/constants.ts`, held to it by the same guard.
// Between packaged launches the engine has to be gone: the sidecar adopts one
// that is still listening here, and an adopted engine is not a cold start.
const ENGINE_PORT = 9876;
const ENGINE_EXIT_TIMEOUT_MS = 15_000;
const ENGINE_EXIT_POLL_MS = 200;

const STARTUP_LAUNCH_COUNT = 3;
const LAUNCH_TIMEOUT_MS = 90_000;
// Same grace the sidecar itself gives the engine before SIGKILL
// (ENGINE_GRACEFUL_EXIT_TIMEOUT_MS in app/electron/constants.ts).
const TERMINATE_GRACE_MS = 5_000;
const OUTPUT_TAIL_LINES = 20;
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

/**
 * Ask nicely, then insist - and wait for the exit either way.
 *
 * The packaged app has a child of its own, the engine sidecar, and only the
 * app's own quit path stops it. On POSIX `SIGTERM` reaches that path
 * (`quit-signals.ts`). On Windows there is no such signal - `kill` is
 * `TerminateProcess`, which takes the app and leaves the engine listening for
 * the next launch to adopt - so the tree is killed explicitly there instead.
 */
async function terminateAndWait(child, exited) {
	if (child.exitCode !== null || child.signalCode !== null) return;

	if (process.platform === "win32") {
		try {
			execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
		} catch {
			// Already gone, or gone between the check and the call. The wait below
			// is what settles it either way.
		}
		await exited;
		return;
	}

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

/** Read one stream line by line, handing each whole line to `onLine`. */
function readLines(stream, onLine) {
	let buffered = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffered += chunk;
		let newlineAt;
		while ((newlineAt = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, newlineAt);
			buffered = buffered.slice(newlineAt + 1);
			onLine(line);
		}
	});
}

/**
 * Launch something once, watch its output for a marker line, and tear the
 * process down before returning either way.
 *
 * `spec` is `{ command, args, env, marker }`. Resolves to
 * `{ ok: true, payload }` or `{ ok: false, reason }` - never rejects and never
 * throws, so a bad launch is data, not an exception.
 *
 * Both the harness and the packaged app come through here rather than through
 * two copies of it: the difference between them is a command line, an
 * environment variable and which marker to wait for, and a second copy would be
 * a second place for the teardown and the timeout to drift.
 *
 * Both streams are scanned for the marker, not stdout alone. A packaged Windows
 * build is a GUI-subsystem executable whose console handles are whatever the
 * parent hands it, and a run that put the line on the other pipe would
 * otherwise read as a timeout.
 */
async function launchOnce(spec, repoRoot) {
	const child = spawn(spec.command, spec.args, {
		cwd: repoRoot,
		env: spec.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Both streams, and distinct lines only. The app says why it failed on
	// stdout - `[Main] Failed to start engine: ...` is a console.log - while
	// Chromium's own noise goes to stderr and repeats: on a runner with no
	// session bus, three dbus messages rotate often enough to fill any tail
	// kept in arrival order, so a stderr-only tail reported the environment's
	// complaints and dropped the app's. A line seen again moves to the end
	// rather than taking a second slot.
	const tail = new Map();
	const recordLine = (line) => {
		if (!line.trim()) return;
		tail.delete(line);
		tail.set(line, true);
		if (tail.size > OUTPUT_TAIL_LINES) tail.delete(tail.keys().next().value);
	};

	const exited = new Promise((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	let spawnError = null;
	child.on("error", (err) => {
		spawnError = err.message;
	});

	const markerFound = new Promise((resolve) => {
		const scan = (line) => {
			const markerAt = line.indexOf(spec.marker);
			if (markerAt === -1) return;
			try {
				const payload = JSON.parse(line.slice(markerAt + spec.marker.length).trim());
				if (typeof payload.readyToShowMs === "number") resolve({ ok: true, payload });
			} catch {
				// Malformed marker line - keep reading rather than failing on it;
				// the timeout or exit below is the real backstop.
			}
		};

		for (const stream of [child.stdout, child.stderr]) {
			readLines(stream, (line) => {
				scan(line);
				recordLine(line);
			});
		}
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
	if (!result.ok && tail.size > 0) {
		result = { ...result, reason: `${result.reason} - output tail: ${[...tail.keys()].join(" | ")}` };
	}

	await terminateAndWait(child, exited);
	return result;
}

/**
 * Launch `STARTUP_LAUNCH_COUNT` times, collecting one marker payload each.
 *
 * `between` runs after each teardown and may veto the run - it is how the
 * packaged leg refuses to measure a launch that would adopt the previous
 * launch's engine instead of starting one.
 */
async function timeLaunches(spec, repoRoot, label, between = null) {
	const payloads = [];
	for (let i = 0; i < STARTUP_LAUNCH_COUNT; i++) {
		const attempt = `${label} launch ${i + 1}/${STARTUP_LAUNCH_COUNT}`;
		const result = await launchOnce(spec, repoRoot);
		if (!result.ok) return { ok: false, reason: `${attempt}: ${result.reason}` };
		payloads.push(result.payload);

		if (between) {
			const cleared = await between();
			if (!cleared.ok) return { ok: false, reason: `${attempt}: ${cleared.reason}` };
		}
	}
	return { ok: true, payloads };
}

/** The harness's own launches, reduced to the numbers they report. */
async function timeHarness(electronBin, repoRoot, harnessArgs, label) {
	const spec = {
		command: electronBin,
		args: [HARNESS_SCRIPT, ...harnessArgs],
		marker: HARNESS_MARKER,
	};
	const result = await timeLaunches(spec, repoRoot, label);
	if (!result.ok) return result;

	const launches = result.payloads.map((payload) => payload.readyToShowMs);
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
// (c) packagedStartup - the real app, as a user launches it
// --------------------------------------------------------------------------

/** Directory names electron-builder gives an unpacked build, by platform. */
const PACKAGED_DIR_NAMES = {
	linux: /^linux-(unpacked|arm64-unpacked|armv7l-unpacked)$/,
	win32: /^win-(unpacked|ia32-unpacked|arm64-unpacked)$/,
	darwin: /^mac(-arm64|-universal|-x64)?$/,
};

/** Files beside the executable in an unpacked build that are not it. */
const NOT_THE_EXECUTABLE = new Set([
	"chrome-sandbox",
	"chrome_crashpad_handler",
	"crashpad_handler",
	"elevate.exe",
]);

function subdirectories(dir) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/**
 * The macOS executable inside a `.app`, which the bundle names.
 *
 * `Contents/MacOS/` holds exactly one file for an Electron app, so it is read
 * rather than the product name assumed - the bundle is named from
 * `electron-builder.json`'s productName and the executable need not match it.
 */
function macExecutableIn(appBundle) {
	const macOsDir = path.join(appBundle, "Contents", "MacOS");
	if (!existsSync(macOsDir)) return null;
	const entries = readdirSync(macOsDir, { withFileTypes: true }).filter((entry) => entry.isFile());
	return entries.length === 1 ? path.join(macOsDir, entries[0].name) : null;
}

/**
 * The one unpacked build directory inside electron-builder's output.
 *
 * Exactly one, or a reason: a second matching directory means a stale build
 * from another architecture is sitting beside this one, and picking either
 * would measure whichever happened to sort first.
 */
function resolveUnpackedDirectory(packagedDir) {
	if (!existsSync(packagedDir)) {
		return { ok: false, reason: `no packaged build at ${packagedDir} - was electron-builder run?` };
	}

	const pattern = PACKAGED_DIR_NAMES[process.platform];
	if (!pattern) return { ok: false, reason: `no packaged layout known for ${process.platform}` };

	const candidates = subdirectories(packagedDir).filter((name) => pattern.test(name));
	if (candidates.length === 1) return { ok: true, unpacked: path.join(packagedDir, candidates[0]) };

	const holding = subdirectories(packagedDir).join(", ") || "no directories";
	const what =
		candidates.length === 0
			? "no unpacked build directory"
			: `${candidates.length} unpacked build directories (${candidates.join(", ")}) - only one can be the answer`;
	return { ok: false, reason: `${what} under ${packagedDir} (holding: ${holding})` };
}

/**
 * The executable inside an unpacked build, on the two platforms that put it at
 * the top of that directory beside the helpers that are not it.
 */
function flatExecutableIn(unpacked) {
	const wanted = process.platform === "win32" ? /\.exe$/i : /^[^.]+$/;
	const executables = readdirSync(unpacked, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !NOT_THE_EXECUTABLE.has(entry.name) && wanted.test(entry.name))
		.map((entry) => entry.name);

	if (executables.length !== 1) {
		return {
			ok: false,
			reason: `expected one executable in ${unpacked}, found ${executables.length === 0 ? "none" : executables.join(", ")}`,
		};
	}
	return { ok: true, executable: path.join(unpacked, executables[0]) };
}

/** The macOS executable, which is one bundle deeper than the other two. */
function bundledExecutableIn(unpacked) {
	const bundle = subdirectories(unpacked).find((name) => name.endsWith(".app"));
	if (!bundle) return { ok: false, reason: `no .app bundle under ${unpacked}` };

	const executable = macExecutableIn(path.join(unpacked, bundle));
	return executable
		? { ok: true, executable }
		: { ok: false, reason: `no single executable in ${bundle}/Contents/MacOS` };
}

/**
 * The app executable inside an electron-builder output directory.
 *
 * Returns `{ ok: true, executable }` or `{ ok: false, reason }` naming what was
 * found instead - a resolver that guessed wrong would otherwise surface as a
 * spawn error three launches later.
 */
function resolvePackagedExecutable(packagedDir) {
	const found = resolveUnpackedDirectory(packagedDir);
	if (!found.ok) return found;

	return process.platform === "darwin"
		? bundledExecutableIn(found.unpacked)
		: flatExecutableIn(found.unpacked);
}

/** Whether anything is listening on the engine's port right now. */
function enginePortAnswers() {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: ENGINE_PORT });
		const settle = (answered) => {
			socket.destroy();
			resolve(answered);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
		socket.setTimeout(ENGINE_EXIT_POLL_MS, () => settle(false));
	});
}

/**
 * Wait for the engine the launch just started to be gone.
 *
 * The sidecar adopts an engine already listening on the port instead of
 * spawning one (`sidecar.ts`), so a leftover engine would make the second and
 * third launches measure an adoption - faster, and not a cold start. Refusing
 * to measure that is the point: the reason travels into `note` rather than into
 * a number nobody can tell apart from a good one.
 */
async function waitForEngineToExit() {
	const deadline = Date.now() + ENGINE_EXIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await enginePortAnswers())) return { ok: true };
		await sleep(ENGINE_EXIT_POLL_MS);
	}
	return {
		ok: false,
		reason: `an engine was still listening on ${ENGINE_PORT} ${ENGINE_EXIT_TIMEOUT_MS}ms after the app was told to quit - the next launch would have adopted it rather than starting one`,
	};
}

/**
 * Time the packaged app from process start to `ready-to-show`, 3 times.
 *
 * This is the number #1165 asks for and the harness leg cannot give: the
 * executable's own load, the main process's import graph, the window it
 * creates and the renderer inside it, in the layout a user installs, with the
 * sidecar spawn running alongside. Not the engine handshake - #1144 put the
 * window ahead of that on purpose, and this measures what a user waits for.
 * `VAYU_MEASURE_STARTUP=1` is what makes the app print the line at all - see
 * `app/electron/startup-probe.ts`.
 */
async function measurePackagedStartup(repoRoot, packagedDir) {
	const unavailable = (note) => ({
		method: "unavailable",
		launches: [],
		medianMs: null,
		basis: null,
		note,
	});

	if (!packagedDir) {
		return unavailable("not measured - no --packaged-dir was given, so nothing was packaged to launch");
	}

	const resolved = resolvePackagedExecutable(path.resolve(repoRoot, packagedDir));
	if (!resolved.ok) return unavailable(resolved.reason);

	const spec = {
		command: resolved.executable,
		args: [],
		env: { ...process.env, [PACKAGED_MEASURE_ENV]: "1" },
		marker: PACKAGED_MARKER,
	};
	const result = await timeLaunches(spec, repoRoot, "packaged", waitForEngineToExit);
	if (!result.ok) return unavailable(result.reason);

	const launches = result.payloads.map((payload) => payload.readyToShowMs);
	// Every launch on one machine reports the same basis; a mixture would mean
	// the app measured two different things across three launches.
	const bases = [...new Set(result.payloads.map((payload) => payload.basis))];
	if (bases.length !== 1) {
		return unavailable(`the launches disagreed on what they measured from: ${bases.join(", ")}`);
	}

	return {
		method: "packaged-cold-start",
		launches,
		medianMs: median(launches),
		basis: bases[0],
		note: null,
	};
}

// --------------------------------------------------------------------------
// (d) tasklistSpawn - Windows only
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
	let packagedDir = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") out = argv[++i];
		else if (argv[i] === "--packaged-dir") packagedDir = argv[++i];
	}
	if (!out) {
		console.error(
			"[perf] usage: node scripts/perf/measure-app.mjs --out <path> [--packaged-dir <electron-builder output dir>]"
		);
		process.exit(2);
	}
	return { out, packagedDir };
}

async function main() {
	const { out, packagedDir } = parseArgs(process.argv.slice(2));
	// cwd is the repo root - see the workflow step that invokes this script.
	const repoRoot = process.cwd();

	const bundle = measureBundle(repoRoot);
	// The packaged app first, so it launches into a machine no harness run has
	// just warmed - the leg whose absolute number is the one anybody quotes.
	const packagedStartup = await measurePackagedStartup(repoRoot, packagedDir);
	const startup = await measureStartup(repoRoot);
	const tasklistSpawn = measureTasklistSpawn();

	const result = {
		schema: 2,
		os: process.platform,
		bundle,
		packagedStartup,
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
