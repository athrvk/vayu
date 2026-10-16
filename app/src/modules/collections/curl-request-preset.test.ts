/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { importCommand } from "@/services/curl/parseCurl";
import { presetFromCommand } from "./curl-request-preset";

function preset(command: string) {
	const imported = importCommand(command);
	if (!imported) throw new Error("not a command");
	return presetFromCommand(imported.request);
}

describe("presetFromCommand", () => {
	it("carries the method, url, headers, body, auth and send settings in stored shapes", () => {
		const result = preset(
			`curl -k -L -u me:pw -X PUT https://x.test/a?q=1 -H 'Content-Type: application/json' -d '{"a":1}'`
		);

		expect(result).toMatchObject({
			method: "PUT",
			url: "https://x.test/a?q=1",
			params: [{ key: "q", value: "1", enabled: true }],
			headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
			body: { mode: "json", content: '{"a":1}' },
			bodyType: "json",
			auth: { mode: "basic", username: "me", password: "pw" },
			verifySSL: false,
			followRedirects: true,
		});
	});

	it("states an empty body as mode none", () => {
		expect(preset("curl https://x.test/a")).toMatchObject({
			body: { mode: "none" },
			bodyType: "none",
		});
	});
});
