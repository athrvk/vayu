/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `log.ts`'s redaction is a port of the engine's `log_redact.hpp`. Both read
 * `engine/tests/fixtures/log-redaction-conformance.json`, so a name or URL case
 * added there fails whichever side answers it differently.
 *
 * Mutation check: restore the first-`@` split in `stripUrlSecrets` and the
 * `http://u:p@ss@h` case reds; drop `x-api-key` from `SECRET_FIELD_NAMES` and
 * its field-name case reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { isSecretFieldName, stripUrlSecrets } from "./log";

const fixture = JSON.parse(
	readFileSync(fromRepoRoot("engine/tests/fixtures/log-redaction-conformance.json"), "utf8")
) as {
	secretFieldNames: string[];
	notSecretFieldNames: string[];
	stripUrlSecrets: { name: string; in: string; out: string }[];
};

describe("log redaction conformance", () => {
	it("read a non-empty fixture", () => {
		expect(fixture.secretFieldNames.length).toBeGreaterThan(0);
		expect(fixture.stripUrlSecrets.length).toBeGreaterThan(0);
	});

	it.each(fixture.secretFieldNames)("redacts the field %s", (name) => {
		expect(isSecretFieldName(name)).toBe(true);
	});

	it.each(fixture.notSecretFieldNames)("passes the field %s through", (name) => {
		expect(isSecretFieldName(name)).toBe(false);
	});

	it.each(fixture.stripUrlSecrets)("stripUrlSecrets: $name", ({ in: input, out }) => {
		expect(stripUrlSecrets(input)).toBe(out);
	});
});
