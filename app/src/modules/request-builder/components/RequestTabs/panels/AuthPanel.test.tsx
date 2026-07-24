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
 * The request builder's mirror of the collection AuthTab bug (issue #61).
 *
 * A request imported with digest/aws/ntlm auth read as "No Auth" and, because
 * the builder autosaves, the next edit silently wrote `{ mode: "none" }` back -
 * destroying config the user was never shown. The panel must now name the
 * stored mode and warn, exactly as the collection AuthTab does; `auth-mapping`
 * keeps the config so the round-trip no longer loses it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { authToEditor } from "../../../utils/auth-mapping";
import type { RequestAuth } from "@/types";
import AuthPanel from "./AuthPanel";

function renderPanel(auth: RequestAuth) {
	const { authType, authConfig } = authToEditor(auth);
	const request = { authType, authConfig, collectionId: null } as unknown as RequestState;
	const ctx = {
		request,
		updateField: vi.fn(),
		setRequest: vi.fn(),
		resolveString: (s: string) => s,
		// The editable branches render VariableInput, which reads these.
		getAllVariables: () => ({}),
		getVariable: () => null,
		resolveVariables: (s: string) => s,
		updateVariable: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	return render(
		<RequestBuilderContext.Provider value={ctx}>
			<AuthPanel />
		</RequestBuilderContext.Provider>
	);
}

describe("AuthPanel with an auth mode it cannot edit", () => {
	it("names the stored mode instead of reading No Auth", () => {
		renderPanel({ mode: "digest", config: { username: "u" } });

		expect(screen.getByText(/Digest auth is set/i)).toBeInTheDocument();
		expect(screen.getByText(/Picking a type above replaces it/i)).toBeInTheDocument();
		// The "No Auth" empty state is what the picker falls back to - it must not
		// claim the request has no auth when it has digest.
		expect(
			screen.queryByText(/No authentication will be sent with this request/i)
		).not.toBeInTheDocument();
	});

	it("labels aws and ntlm too", () => {
		renderPanel({ mode: "aws", config: {} });
		expect(screen.getByText(/AWS Signature auth is set/i)).toBeInTheDocument();

		renderPanel({ mode: "ntlm", config: {} });
		expect(screen.getByText(/NTLM auth is set/i)).toBeInTheDocument();
	});
});

describe("AuthPanel with an editable mode", () => {
	it("does not warn when the mode is one it understands", () => {
		renderPanel({ mode: "bearer", token: "abc" });
		expect(screen.queryByText(/not editable here/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/auth is set/i)).not.toBeInTheDocument();
	});

	it("shows the No Auth empty state when there genuinely is none", () => {
		renderPanel({ mode: "none" });
		expect(
			screen.getByText(/No authentication will be sent with this request/i)
		).toBeInTheDocument();
	});
});
