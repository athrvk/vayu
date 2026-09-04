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

import { describe, it, expect } from "vitest";
import {
	createOpenIntents,
	isImportableFile,
	parseOpenIntents,
	type OpenIntent,
} from "./open-intent";
import { OPEN_COLLECTION_ARG } from "./os-icon";

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

	it("finds nothing on an ordinary launch", () => {
		expect(parseOpenIntents(["vayu", "--enable-logging", "."])).toEqual([]);
	});
});

describe("createOpenIntents", () => {
	function harness(options: { sends?: boolean } = {}) {
		const sent: OpenIntent[] = [];
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
		});
		return {
			intents,
			sent,
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

	it("delivers each waiting intent once", () => {
		const os = harness();
		os.intents.offer({ kind: "import", path: "a.json" });
		os.intents.ready();
		os.intents.ready();
		expect(os.sent).toEqual([{ kind: "import", path: "a.json" }]);
	});
});
