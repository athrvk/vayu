/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { describeEngineCrash, engineCrashOutput } from "./engine-crash";

const base = { code: null, signal: null, stderrTail: [], error: null };

describe("describeEngineCrash", () => {
	it("names the exit code", () => {
		expect(describeEngineCrash({ ...base, code: 3 })).toBe("Vayu's engine exited with code 3.");
	});

	it("names a code of zero rather than treating it as absent", () => {
		expect(describeEngineCrash({ ...base, code: 0 })).toBe("Vayu's engine exited with code 0.");
	});

	it("names the signal that stopped it", () => {
		expect(describeEngineCrash({ ...base, signal: "SIGKILL" })).toBe(
			"Vayu's engine was stopped by signal SIGKILL."
		);
	});

	it("puts a failure to run ahead of the exit it was followed by", () => {
		expect(describeEngineCrash({ ...base, code: 1, error: "spawn ENOENT" })).toBe(
			"Vayu's engine reported an error - spawn ENOENT"
		);
	});

	it("still says something when the record carries nothing", () => {
		expect(describeEngineCrash(base)).toBe("Vayu's engine exited unexpectedly.");
	});
});

describe("engineCrashOutput", () => {
	it("keeps the last three non-empty lines", () => {
		const stderrTail = ["one", "two", "", "three", "four  "];
		expect(engineCrashOutput({ ...base, stderrTail })).toBe("two\nthree\nfour");
	});

	it("is empty when the engine printed nothing", () => {
		expect(engineCrashOutput(base)).toBe("");
	});
});
