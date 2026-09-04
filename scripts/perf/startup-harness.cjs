/**
 * An Electron main script that times how long a window takes to become
 * showable, with and without the app's built renderer in it.
 *
 * Run by `scripts/perf/measure-app.mjs` (issue #1162), never by a user. It is
 * deliberately NOT the Vayu app: it creates one BrowserWindow, loads either a
 * blank page or `app/dist/index.html`, prints the time to `ready-to-show` and
 * quits. The difference between the two is the cost of parsing and evaluating
 * the renderer's module graph - the number #1146 is about (one 5.5 MB entry
 * chunk, zero React.lazy) and the one #1147's bundle work would move.
 *
 * Why a harness alongside the real app, rather than instead of it:
 * `measure-app.mjs` also packages and launches the real app now (#1165,
 * `--packaged-dir`), and that figure is the one to quote for a user's cold
 * start. This harness stays because that packaged number cannot be pulled
 * apart afterward: it is the executable's load, the main process's import
 * graph, the window it creates and the renderer inside it, all in one
 * measurement, with the sidecar spawn running alongside them. This
 * script isolates the last piece alone - a window of its own, holding either
 * nothing or the built renderer, with none of the main process's own work in
 * the picture - which is the blank-window baseline vs full-renderer delta
 * #1162 named as the sweep's method, and the number #1146/#1147's bundle work
 * moves.
 *
 * What it therefore does NOT measure, so nobody reads more into the number:
 * the main process's own startup work - the eager MCP import (#1145), the
 * sidecar spawn (#1148), the engine handshake (#1144). Those are main.ts's,
 * and this harness never loads it.
 *
 * What it DOES include, which is easy to mistake for noise: the renderer's
 * render-blocking network fetches. `index.html` pulls six Google Fonts
 * families before first paint (#1149), so the renderer figure moves with the
 * runner's network and will drop when that lands - a property worth keeping,
 * since it is what a real cold start pays. On a machine with no route to
 * fonts.googleapis.com the figure is dominated by that stall (measured: 12.8s
 * against a 248ms blank baseline in a sandboxed container), which is why the
 * blank baseline is reported beside it rather than the delta alone.
 *
 * CommonJS on purpose: Electron's main entry is loaded as CJS unless the
 * package is typed as a module, and this file is run directly by path.
 *
 * Usage (via measure-app.mjs):
 *   electron scripts/perf/startup-harness.cjs --mode blank|renderer --entry <index.html>
 */

const { app, BrowserWindow } = require("electron");

/** The line measure-app.mjs scans for, followed by a JSON payload. */
const HARNESS_MARKER = "[perf] harness";

// A blank document rather than a file, so the baseline measures window
// creation and first paint with nothing of ours in it.
const BLANK_PAGE = "data:text/html,<!doctype html><title>blank</title>";

function parseArgs(argv) {
	const args = { mode: "blank", entry: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--mode") args.mode = argv[++i];
		if (argv[i] === "--entry") args.entry = argv[++i];
	}
	return args;
}

function report(payload) {
	process.stdout.write(`${HARNESS_MARKER} ${JSON.stringify(payload)}\n`);
}

function main() {
	const { mode, entry } = parseArgs(process.argv.slice(2));
	if (mode !== "blank" && mode !== "renderer") {
		process.stderr.write(`[perf] unknown --mode ${mode}\n`);
		app.exit(2);
		return;
	}
	if (mode === "renderer" && !entry) {
		process.stderr.write("[perf] --mode renderer needs --entry <index.html>\n");
		app.exit(2);
		return;
	}

	const window = new BrowserWindow({
		show: false,
		width: 1280,
		height: 800,
		// No preload: the renderer's `window.electronAPI` is main.ts's to
		// provide, and wiring one here would drag main-process modules into a
		// measurement that is about the renderer graph. The page will report
		// errors once it runs; `ready-to-show` fires before that and is what
		// this measures.
		webPreferences: { contextIsolation: true, nodeIntegration: false },
	});

	window.once("ready-to-show", () => {
		// performance.now() in the main process is measured from process start,
		// so this value is already "ready-to-show minus process start".
		report({ mode, readyToShowMs: performance.now() });
		app.quit();
	});

	// A page that never becomes showable must not hang the run; the parent has
	// its own timeout, but exiting here names the reason in this process's log.
	window.webContents.on("did-fail-load", (_event, code, description) => {
		process.stderr.write(`[perf] load failed (${code}): ${description}\n`);
		app.exit(3);
	});

	if (mode === "blank") {
		window.loadURL(BLANK_PAGE);
		return;
	}
	window.loadFile(entry);
}

app.whenReady().then(main);
