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
 * Codes the engine sends with `status: 0` that are not a network failure.
 *
 * Each of these used to fall through to "Couldn't get a response", which
 * blames the network for a token Vayu couldn't fetch, a method/body pair it
 * refused, or a data row it couldn't bind (docs/ux-writing.md, "Errors have
 * three sources").
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ClientErrorView from "./ClientErrorView";

describe("ClientErrorView headings for non-network codes", () => {
	it.each([
		["AUTH_FAILED", "Couldn't get an OAuth 2.0 token", /Auth tab's token settings/],
		["AUTH_REQUIRED", "This request needs an OAuth 2.0 token", /Open the Auth tab/],
		["INVALID_METHOD", "Couldn't send - the method doesn't allow this", /Remove the body/],
		["DATA_BINDING_FAILED", "Couldn't bind the data row", /column names in the data file/],
	])("names %s rather than a missing response", (code, title, hint) => {
		render(<ClientErrorView errorCode={code} errorMessage="detail" />);

		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByText(hint)).toBeInTheDocument();
		expect(screen.queryByText("Couldn't get a response")).not.toBeInTheDocument();
	});
});
