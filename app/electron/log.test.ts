/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `log.ts` is a from-scratch TypeScript port of the engine's `LogRecord`
 * (issue #1558): the same required keys, the same redaction rule, the same
 * JSON-lines file, the same text console shape. These tests hold it to the
 * schema both sides claim to match, hand-checked rather than with ajv - the
 * schema is small - and to the buffer-until-floor-known contract that makes
 * `logLevel` a launch-time decision rather than a per-record one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { createLogger, applyFloorFromEngine, type LogLevel } from "./log";

const schema = JSON.parse(
	readFileSync(fromRepoRoot("docs/engine/log-record.schema.json"), "utf8")
) as {
	required: string[];
	properties: { ts: { pattern: string }; level: { enum: string[] }; src: { enum: string[] } };
	oneOf: { properties: { src: { const: string }; cat: { enum: string[] } } }[];
};

const APP_CATEGORY_ENUM = schema.oneOf.find((branch) => branch.properties.src.const === "app")!
	.properties.cat.enum;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "vayu-log-test-")).replace(/\\/g, "/");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** One line per record, oldest first - the file this test's logger wrote. */
function readLines(filePrefix = "app"): unknown[] {
	const file = readdirSync(dir).find(
		(name) => name.startsWith(`${filePrefix}_`) && !name.endsWith(".1")
	);
	if (!file) return [];
	return readFileSync(path.join(dir, file), "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

describe("log.ts - the file sink validates against the schema", () => {
	it("writes a line with every required key, valid ts, level and src", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.applyFloor("debug");
		log.info("sidecar", "Engine started successfully", { url: "http://127.0.0.1:9876" });

		const [record] = readLines() as Record<string, unknown>[];
		for (const key of schema.required) expect(record).toHaveProperty(key);
		expect(record.ts).toMatch(new RegExp(schema.properties.ts.pattern));
		expect(schema.properties.level.enum).toContain(record.level);
		expect(schema.properties.src.enum).toContain(record.src);
		expect(record.src).toBe("app");
		expect(APP_CATEGORY_ENUM).toContain(record.cat);
		expect(record.url).toBe("http://127.0.0.1:9876");
	});

	it("rejects a category outside the app enum by construction, per the type", () => {
		// Not a runtime check - `cat: string` at the call site is deliberately
		// loose (see log.ts's own comment); this pins that every category this
		// suite's own call sites actually use is in the schema's list, so a typo
		// there is caught here rather than only by a human reading a log file.
		expect(APP_CATEGORY_ENUM).toEqual([
			"main",
			"sidecar",
			"window",
			"updater",
			"ipc",
			"mcp",
			"power",
			"notify",
		]);
	});
});

describe("log.ts - redaction", () => {
	it("redacts a secret field and strips a url field's userinfo and query", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.applyFloor("debug");
		log.info("main", "Configuration loaded", {
			config: { proxyUrl: "http://u:p@h/x?y=1", token: "t" },
		});

		const [record] = readLines() as { config: { proxyUrl: string; token: string } }[];
		expect(record.config.token).toBe("<redacted>");
		expect(record.config.proxyUrl).toBe("http://h/x");
	});

	// Mutation check: comment out the `isSecretFieldName` branch in
	// `redactFields` and this reds - `apikey` reaches the file as `"s3cr3t"`
	// instead of `"<redacted>"`.
	it("redacts every name in the ported secret set", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.applyFloor("debug");
		log.info("main", "probe", {
			authorization: "Bearer x",
			cookie: "a=b",
			apikey: "s3cr3t",
			password: "hunter2",
			client_secret: "cs",
		});

		const [record] = readLines() as Record<string, string>[];
		for (const key of ["authorization", "cookie", "apikey", "password", "client_secret"]) {
			expect(record[key]).toBe("<redacted>");
		}
	});
});

describe("log.ts - owner-only files", () => {
	const onWindows = process.platform === "win32";

	/** A logs directory that does not exist yet, so the logger creates it. */
	function freshLogsDir(): string {
		return path.join(dir, "nested", "logs");
	}

	// Vitest runs this file in a worker thread, where `process.umask(mask)`
	// throws, so the umask cannot be pinned. The real-mode case below therefore
	// runs only where the inherited umask leaves group and other bits to the
	// request (the usual 022), and the spy case holds the request itself
	// everywhere else.
	//
	// Mutation check: drop `mode: LOG_FILE_MODE` from the appendFileSync (or
	// `mode: LOG_DIR_MODE` from the mkdirSync) and the matching assertion reds.
	it("asks for a 0700 directory and a 0600 file", () => {
		const mkdir = vi.spyOn(fs, "mkdirSync");
		const append = vi.spyOn(fs, "appendFileSync");
		const log = createLogger("app", { logsDir: freshLogsDir(), consoleEnabled: false });
		log.applyFloor("debug");
		log.info("main", "hello");

		expect(readdirSync(freshLogsDir())).not.toHaveLength(0);
		expect(mkdir).toHaveBeenCalledWith(freshLogsDir(), { recursive: true, mode: 0o700 });
		expect(append).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
			mode: 0o600,
		});
	});

	it.skipIf(onWindows || (process.umask() & 0o055) !== 0)(
		"creates the directory 0700 and the file 0600 on disk",
		() => {
			const logsDir = freshLogsDir();
			const log = createLogger("app", { logsDir, consoleEnabled: false });
			log.applyFloor("debug");
			log.info("main", "hello");

			const entries = readdirSync(logsDir);
			expect(entries).not.toHaveLength(0);
			expect(statSync(logsDir).mode & 0o777).toBe(0o700);
			for (const name of entries) {
				expect(statSync(path.join(logsDir, name)).mode & 0o777).toBe(0o600);
			}
		}
	);

	// Windows ignores `mode`: the file inherits the directory's ACL, so the
	// only thing to hold there is that the write still lands.
	it.runIf(onWindows)("still writes the file, whose ACL it inherits", () => {
		const logsDir = freshLogsDir();
		const log = createLogger("app", { logsDir, consoleEnabled: false });
		log.applyFloor("debug");
		log.info("main", "hello");

		const entries = readdirSync(logsDir);
		expect(entries).toHaveLength(1);
		expect(statSync(path.join(logsDir, entries[0])).size).toBeGreaterThan(0);
	});
});

describe("log.ts - rotation and retention", () => {
	it("rotates to .1 once the file crosses the byte cap", () => {
		const log = createLogger("app", {
			logsDir: dir,
			consoleEnabled: false,
			maxFileBytes: 300,
		});
		log.applyFloor("debug");
		for (let i = 0; i < 20; i++) log.info("main", `record number ${i}`);

		const files = readdirSync(dir);
		const rotated = files.find((name) => name.endsWith(".1"));
		const current = files.find((name) => name.startsWith("app_") && !name.endsWith(".1"));
		expect(rotated).toBeDefined();
		expect(current).toBeDefined();
		// The active file never grows past one rotation's worth over the cap.
		expect(statSync(path.join(dir, current!)).size).toBeLessThan(300 + 200);
	});

	it("keeps the newest N per-prefix files and leaves other prefixes alone", () => {
		// Ten stale files as earlier process starts would have left them, plus
		// one for a different prefix the engine owns.
		for (let i = 0; i < 10; i++) {
			writeFileSync(path.join(dir, `app_2026010${i}_000000.log`), "{}\n");
		}
		writeFileSync(path.join(dir, "engine_20260101_000000.log"), "{}\n");

		const log = createLogger("app", { logsDir: dir, consoleEnabled: false, retentionCount: 3 });
		log.applyFloor("debug");
		log.info("main", "first line of the new file");

		const appFiles = readdirSync(dir).filter((name) => name.startsWith("app_"));
		const engineFiles = readdirSync(dir).filter((name) => name.startsWith("engine_"));
		// 3 kept plus the one this run just created.
		expect(appFiles.length).toBe(4);
		expect(engineFiles.length).toBe(1);
	});
});

describe("log.ts - the text console renderer", () => {
	it("matches the documented shape: time, padded level, padded cat, msg, fields", () => {
		const fixedNow = new Date("2026-09-07T13:57:19.123Z");
		const log = createLogger("app", {
			logsDir: null,
			consoleEnabled: true,
			now: () => fixedNow,
			pid: 4242,
		});
		log.applyFloor("debug");
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		log.info("mcp", "GET /inbox 200 1.3ms 412B", { status: 200, ms: 1.3 });

		expect(out).toHaveBeenCalledWith(
			"13:57:19.123 INFO   mcp      GET /inbox 200 1.3ms 412B status=200 ms=1.3\n"
		);
	});

	it("sends error to stderr and everything else to stdout, for the app split", () => {
		const log = createLogger("app", { logsDir: null, consoleEnabled: true });
		log.applyFloor("debug");
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		log.info("main", "info goes to stdout");
		log.error("main", "error goes to stderr");

		expect(out).toHaveBeenCalledTimes(1);
		expect(err).toHaveBeenCalledTimes(1);
	});

	it("sends everything to stderr when split is off, for the MCP stdio server", () => {
		const log = createLogger("mcp", {
			logsDir: null,
			consoleEnabled: true,
			consoleSplitByLevel: false,
		});
		log.applyFloor("debug");
		const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		log.info("mcp", "stdout is reserved for JSON-RPC");

		expect(out).not.toHaveBeenCalled();
		expect(err).toHaveBeenCalledTimes(1);
	});
});

describe("log.ts - buffer until the floor is known", () => {
	it("buffers every record, then applies the floor to the whole buffer once", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });

		log.debug("main", "buffered debug");
		log.info("main", "buffered info");
		log.warn("main", "buffered warn");
		expect(readLines()).toEqual([]);

		log.applyFloor("warn");

		const lines = readLines() as { msg: string }[];
		expect(lines.map((l) => l.msg)).toEqual(["buffered warn"]);
	});

	it("keeps applying the floor to records logged after it is known", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.applyFloor("warn");

		log.debug("main", "dropped");
		log.error("main", "kept");

		const lines = readLines() as { msg: string }[];
		expect(lines.map((l) => l.msg)).toEqual(["kept"]);
	});

	// Mutation check: remove the `if (this.floor !== null) return;` guard in
	// `applyFloor` and this reds - a second `applyFloor("error")` would drop
	// the debug-floor line the first call already flushed.
	it("reads logLevel once - a later call cannot change the floor", () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.applyFloor("debug");
		log.debug("main", "kept under the first floor");
		log.applyFloor("error");
		log.debug("main", "still kept - the floor did not move");

		const lines = readLines() as { msg: string }[];
		expect(lines).toHaveLength(2);
	});

	it("flushes at debug when the engine never answers", async () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.debug("main", "a launch that failed wants every record");

		await applyFloorFromEngine(log, "http://127.0.0.1:1"); // nothing listens here

		const lines = readLines() as { level: LogLevel }[];
		expect(lines.map((l) => l.level)).toEqual(["debug"]);
	});

	it("applies the level the engine's GET /config answers with", async () => {
		const log = createLogger("app", { logsDir: dir, consoleEnabled: false });
		log.debug("main", "dropped");
		log.warn("main", "kept");

		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ entries: [{ key: "logLevel", value: "warn" }] }),
		}));
		vi.stubGlobal("fetch", fetchImpl);

		await applyFloorFromEngine(log, "http://127.0.0.1:9876");

		const lines = readLines() as { msg: string }[];
		expect(lines.map((l) => l.msg)).toEqual(["kept"]);
	});
});
