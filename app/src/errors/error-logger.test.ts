/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `logError` forwards through `electronAPI.log` when it is available (#1558)
 * and keeps today's console behaviour outside Electron - both branches
 * stubbed explicitly, since `window.electronAPI` is a capability question,
 * not a platform one, and both answers are real environments this ships to
 * (the packaged app, and the vite-hosted sweep/probe harnesses).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { logError, logApiError } from "./error-logger";

function stubElectron(): { log: ReturnType<typeof vi.fn> } {
	const log = vi.fn();
	vi.stubGlobal("window", { electronAPI: { log } });
	return { log };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("logError - with electronAPI", () => {
	it("forwards critical and high severity as level error", () => {
		const { log } = stubElectron();
		logError(new Error("boom"), "critical");
		logError(new TypeError("boom2"), "high");

		expect(log.mock.calls[0][0]).toMatchObject({ level: "error" });
		expect(log.mock.calls[1][0]).toMatchObject({ level: "error" });
	});

	it("maps medium to warn and low to info", () => {
		const { log } = stubElectron();
		logError(new Error("boom"), "medium");
		logError(new Error("boom"), "low");

		expect(log.mock.calls[0][0]).toMatchObject({ level: "warn" });
		expect(log.mock.calls[1][0]).toMatchObject({ level: "info" });
	});

	it("carries the error's name, message and stack under err", () => {
		const { log } = stubElectron();
		const error = new Error("something broke");

		logError(error, "high");

		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				err: { name: "Error", message: "something broke", stack: error.stack },
			})
		);
	});

	it("falls back to cat 'renderer' for a component name outside the schema's enum", () => {
		const { log } = stubElectron();
		logError(new Error("boom"), "high", { component: "ErrorBoundary" });

		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				cat: "renderer",
				fields: expect.objectContaining({ component: "ErrorBoundary" }),
			})
		);
	});

	it("uses the context's component as cat when it is itself a valid category", () => {
		const { log } = stubElectron();
		logError(new Error("boom"), "high", { component: "boundary" });

		expect(log).toHaveBeenCalledWith(expect.objectContaining({ cat: "boundary" }));
	});

	it("carries severity, action, requestId and metadata as fields", () => {
		const { log } = stubElectron();
		logError(new Error("boom"), "medium", {
			action: "componentDidCatch",
			requestId: "req_1",
			metadata: { componentStack: "  at X" },
		});

		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				fields: {
					severity: "medium",
					action: "componentDidCatch",
					requestId: "req_1",
					metadata: { componentStack: "  at X" },
				},
			})
		);
	});
});

// Mutation check: replace the `if (window.electronAPI)` guard's condition with
// `false` and this whole block reds - every case below currently exercises the
// console branch precisely because there is no electronAPI stubbed.
describe("logError - outside Electron (no window.electronAPI)", () => {
	it("logs high and critical at console.error", () => {
		vi.stubGlobal("window", {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		logError(new Error("boom"), "critical");
		logError(new Error("boom"), "high");

		expect(error).toHaveBeenCalledTimes(2);
	});

	it("logs medium at console.warn and low at console.info", () => {
		vi.stubGlobal("window", {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		logError(new Error("boom"), "medium");
		logError(new Error("boom"), "low");

		expect(warn).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledTimes(1);
	});
});

describe("logApiError", () => {
	it("logs a plain Error as high, and one named ApiError as medium", () => {
		const { log } = stubElectron();

		logApiError(new Error("network down"));
		const apiError = new Error("not found");
		apiError.name = "ApiError";
		logApiError(apiError);

		expect(log.mock.calls[0][0]).toMatchObject({ level: "error" });
		expect(log.mock.calls[1][0]).toMatchObject({ level: "warn" });
	});

	it("wraps a non-Error value in an Error before logging", () => {
		const { log } = stubElectron();

		logApiError("a plain string rejection");

		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.objectContaining({ message: "a plain string rejection" }),
			})
		);
	});
});
