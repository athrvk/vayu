/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the OS asks Vayu to open (#1364).
 *
 * The two things worth asserting are the parse - which decides what an argument
 * on a command line is - and the buffering, which is the whole reason this
 * module exists: a file double-clicked on a cold start arrives before there is
 * anything to send it to.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import {
	createOpenIntents,
	isImportableFile,
	parseOpenIntents,
	type OpenIntent,
} from "./open-intent";
import { NEW_REQUEST_ARG, OPEN_COLLECTION_ARG } from "./os-icon";
import { RESTARTED_AFTER_REBOOT_ARG } from "./restart-registration";

describe("isImportableFile", () => {
	it("takes the extensions the import pipeline reads", () => {
		for (const name of ["a.json", "a.yaml", "a.yml", "/tmp/A.JSON", "C:\\x\\spec.YML"]) {
			expect(isImportableFile(name), name).toBe(true);
		}
	});

	/*
	 * Mutation check: drop the `-` guard and `--vayu-open-collection=x.json`
	 * would be read as a file as well as a collection.
	 */
	it("refuses a flag, and anything the pipeline could not read", () => {
		for (const name of [
			"",
			"--inspect",
			"-h",
			"/opt/vayu/vayu",
			"a.exe",
			"a.csv",
			"a.json.bak",
			"json",
		]) {
			expect(isImportableFile(name), JSON.stringify(name)).toBe(false);
		}
	});
});

describe("parseOpenIntents", () => {
	it("skips argv[0], which is the executable and never a request", () => {
		expect(parseOpenIntents(["/opt/vayu/vayu.json"])).toEqual([]);
	});

	it("reads a file a cold start was launched with", () => {
		expect(parseOpenIntents(["vayu", "/home/u/postman.json"])).toEqual([
			{ kind: "import", path: "/home/u/postman.json" },
		]);
	});

	it("reads a Jump List collection", () => {
		expect(parseOpenIntents(["vayu", `${OPEN_COLLECTION_ARG}col-7`])).toEqual([
			{ kind: "collection", collectionId: "col-7" },
		]);
	});

	/*
	 * Mutation check: give the Jump List's New Request task no argument and this
	 * reddens - a warm launch would reach `second-instance` with nothing on it
	 * and be indistinguishable from double-clicking the icon.
	 */
	it("reads the menu's New Request entry", () => {
		expect(parseOpenIntents(["vayu", NEW_REQUEST_ARG])).toEqual([{ kind: "newRequest" }]);
	});

	it("ignores a collection argument carrying no id", () => {
		expect(parseOpenIntents(["vayu", OPEN_COLLECTION_ARG])).toEqual([]);
	});

	/*
	 * Nothing stops a user selecting two documents and pressing Open, and
	 * dropping the second would be the app deciding which one they meant.
	 */
	it("keeps every intent on the line, in order", () => {
		expect(parseOpenIntents(["vayu", "--enable-logging", "b.yaml", "a.json"])).toEqual([
			{ kind: "import", path: "b.yaml" },
			{ kind: "import", path: "a.json" },
		]);
	});

	/*
	 * Mutation check: pass the argument through undecoded and the intent's path
	 * is the URL itself, which `specFile:read` would refuse (#2000).
	 */
	it("decodes a file:// URL a Linux file manager passes through %U", () => {
		const url = pathToFileURL(path.resolve("specs", "my spec.json"));
		expect(url.href).toContain("my%20spec.json");
		expect(parseOpenIntents(["vayu", url.href])).toEqual([
			{ kind: "import", path: path.resolve("specs", "my spec.json") },
		]);
	});

	it("decodes the URL scheme whatever its case", () => {
		const href = pathToFileURL(path.resolve("a.yaml")).href;
		expect(parseOpenIntents(["vayu", href.replace(/^file/, "FILE")])).toEqual([
			{ kind: "import", path: path.resolve("a.yaml") },
		]);
	});

	it("decodes the one-slash file: form too", () => {
		const target = path.resolve("spec.json");
		const oneSlash = pathToFileURL(target).href.replace(/^file:\/\/\//, "file:/");
		expect(parseOpenIntents(["vayu", oneSlash])).toEqual([{ kind: "import", path: target }]);
	});

	it("drops a file:// URL to something the pipeline could not read", () => {
		const href = pathToFileURL(path.resolve("notes.txt")).href;
		expect(parseOpenIntents(["vayu", href])).toEqual([]);
	});

	it("drops a file:// URL that cannot be decoded rather than throwing", () => {
		// An encoded separator is refused by `fileURLToPath` on every platform.
		expect(parseOpenIntents(["vayu", "file:///tmp/a%2Fb.json", "file://[", "a.json"])).toEqual([
			{ kind: "import", path: "a.json" },
		]);
	});

	it("finds nothing on an ordinary launch", () => {
		expect(parseOpenIntents(["vayu", "--enable-logging", "."])).toEqual([]);
	});

	it("reads nothing into the argument Windows relaunches the app with after a restart", () => {
		expect(parseOpenIntents(["vayu", RESTARTED_AFTER_REBOOT_ARG])).toEqual([]);
	});
});

describe("createOpenIntents", () => {
	function harness(options: { sends?: boolean } = {}) {
		const sent: OpenIntent[] = [];
		const granted: string[] = [];
		let focuses = 0;
		let sends = options.sends ?? true;
		const intents = createOpenIntents({
			send: (intent) => {
				if (!sends) return false;
				sent.push(intent);
				return true;
			},
			focus: () => {
				focuses++;
			},
			grant: (filePath) => {
				granted.push(filePath);
			},
		});
		return {
			intents,
			sent,
			granted,
			focuses: () => focuses,
			setSends(next: boolean) {
				sends = next;
			},
		};
	}

	/*
	 * Mutation check: deliver on `offer` without the `loaded` guard and this
	 * reddens - which is the cold-launch case, where macOS raises `open-file`
	 * before `whenReady` resolves and there is no renderer to send to.
	 */
	it("holds an intent until the renderer says it has loaded", () => {
		const os = harness();
		os.intents.offer({ kind: "import", path: "a.json" });
		expect(os.sent).toEqual([]);
		os.intents.ready();
		expect(os.sent).toEqual([{ kind: "import", path: "a.json" }]);
	});

	it("delivers straight away once the renderer is up", () => {
		const os = harness();
		os.intents.ready();
		os.intents.offer({ kind: "collection", collectionId: "c1" });
		expect(os.sent).toEqual([{ kind: "collection", collectionId: "c1" }]);
	});

	it("brings the window forward, because a launch that opens nothing looks broken", () => {
		const os = harness();
		os.intents.offer({ kind: "import", path: "a.json" });
		expect(os.focuses()).toBe(1);
	});

	/*
	 * Mutation check: drop the re-queue in `deliver` and an intent that met a
	 * window mid-rebuild - macOS `activate` after the last window closed - is
	 * lost with nothing on screen to say the double-click did anything.
	 */
	it("puts an intent back when there turned out to be no window", () => {
		const os = harness();
		os.intents.ready();
		os.setSends(false);
		os.intents.offer({ kind: "import", path: "a.json" });
		expect(os.sent).toEqual([]);
		os.setSends(true);
		os.intents.ready();
		expect(os.sent).toEqual([{ kind: "import", path: "a.json" }]);
	});

	it("keeps the order a command line gave", () => {
		const os = harness();
		os.intents.offerArgv(["vayu", "b.yaml", `${OPEN_COLLECTION_ARG}c1`]);
		os.intents.ready();
		expect(os.sent).toEqual([
			{ kind: "import", path: "b.yaml" },
			{ kind: "collection", collectionId: "c1" },
		]);
	});

	it("does not focus the window for a command line with nothing on it", () => {
		const os = harness();
		os.intents.offerArgv(["vayu", "--enable-logging"]);
		expect(os.focuses()).toBe(0);
	});

	/*
	 * #2356: a document the OS handed over is one the user chose, so its path is
	 * recorded as picked - when offered, before the renderer can read it, and
	 * whichever door it came through. Mutation check: drop the `grant` call in
	 * `offer` and both of these redden.
	 */
	it("records an offered document's path as picked, before delivery", () => {
		const os = harness();
		os.intents.offer({ kind: "import", path: "/docs/a.json" });
		expect(os.granted).toEqual(["/docs/a.json"]);
		expect(os.sent).toEqual([]);
	});

	it("records the documents on a command line and nothing else it carries", () => {
		const os = harness();
		os.intents.offerArgv(["vayu", "/docs/b.yaml", `${OPEN_COLLECTION_ARG}c1`, "/docs/c.txt"]);
		os.intents.offer({ kind: "newRequest" });
		expect(os.granted).toEqual(["/docs/b.yaml"]);
	});

	it("delivers each waiting intent once", () => {
		const os = harness();
		os.intents.offer({ kind: "import", path: "a.json" });
		os.intents.ready();
		os.intents.ready();
		expect(os.sent).toEqual([{ kind: "import", path: "a.json" }]);
	});
});
