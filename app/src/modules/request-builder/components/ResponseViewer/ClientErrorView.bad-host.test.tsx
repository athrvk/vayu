/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tip under a refused URL names the `{{variable}}` in its host (#3500), and
 * only for that code: the generic tip stays for a URL with no variable in its
 * host, and no other code's tip is touched by a URL it did not ask for.
 *
 * Mutation check: drop the `INVALID_URL` branch in `errorHint` and the first
 * case fails; make it apply to every code and the third fails.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ClientErrorView from "./ClientErrorView";

const BAD_HOSTNAME = "URL rejected: Bad hostname";

describe("ClientErrorView tip for INVALID_URL", () => {
	it("names the variable in the host", () => {
		render(
			<ClientErrorView
				errorCode="INVALID_URL"
				errorMessage={BAD_HOSTNAME}
				requestUrl="https://{{baseHost}}/pets"
			/>
		);

		expect(screen.getByText(BAD_HOSTNAME)).toBeInTheDocument();
		expect(screen.getByText(/The host uses \{\{baseHost\}\}/)).toBeInTheDocument();
		expect(screen.queryByText(/percent-encoded/)).not.toBeInTheDocument();
	});

	it("keeps the generic tip when the host holds no variable, or the URL is not known", () => {
		const { rerender } = render(
			<ClientErrorView
				errorCode="INVALID_URL"
				errorMessage={BAD_HOSTNAME}
				requestUrl="https://example.com/{{id}}"
			/>
		);
		expect(screen.getByText(/percent-encoded/)).toBeInTheDocument();

		rerender(<ClientErrorView errorCode="INVALID_URL" errorMessage={BAD_HOSTNAME} />);
		expect(screen.getByText(/percent-encoded/)).toBeInTheDocument();
	});

	it("leaves another code's tip alone", () => {
		render(
			<ClientErrorView
				errorCode="DNS_ERROR"
				errorMessage="Could not resolve host"
				requestUrl="https://{{baseHost}}/pets"
			/>
		);

		expect(screen.getByText(/The host name didn't resolve/)).toBeInTheDocument();
		expect(screen.queryByText(/The host uses/)).not.toBeInTheDocument();
	});
});
