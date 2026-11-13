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
 * Every field of the OAuth 2.0 form announced as its placeholder, the three
 * selects as a bare "combo box" and the PKCE switch as nothing at all (#3498).
 * `field()` renders each `<Label>` through `LabelledField`, which pairs it with
 * the control by id; dropping that pairing fails every query here.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2Config } from "@/types";
import OAuth2Form from "./OAuth2Form";

vi.mock("./TokenStatusRow", () => ({ default: () => null }));

const CONFIG: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://idp.test/token",
	clientId: "cid",
};

function open(value: OAuth2Config) {
	render(
		<TooltipProvider>
			<OAuth2Form value={value} onChange={vi.fn()} />
		</TooltipProvider>
	);
	fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
}

describe("OAuth2Form names its controls", () => {
	it("names the grant type picker and the always-present fields", () => {
		open(CONFIG);

		expect(screen.getByRole("combobox", { name: "Grant type" })).toBeInTheDocument();
		for (const label of ["Access token URL", "Client ID", "Client secret", "Scope"]) {
			expect(screen.getByLabelText(label), label).toBeInTheDocument();
		}
	});

	it("names the Advanced fields and both of its pickers", () => {
		open(CONFIG);

		expect(screen.getByRole("combobox", { name: "Client authentication" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Token placement" })).toBeInTheDocument();
		for (const label of [
			"Header prefix",
			"Credentials ID",
			"Audience",
			"Resource",
			"Refresh token URL",
		]) {
			expect(screen.getByLabelText(label), label).toBeInTheDocument();
		}
	});

	it("names the query param field when the token rides the query", () => {
		open({ ...CONFIG, tokenPlacement: "query" });
		expect(screen.getByLabelText("Query param name")).toBeInTheDocument();
		expect(screen.queryByLabelText("Header prefix")).not.toBeInTheDocument();
	});

	it("names the password grant's credentials", () => {
		open({ ...CONFIG, grantType: "password" });
		expect(screen.getByLabelText("Username")).toBeInTheDocument();
		expect(screen.getByLabelText("Password")).toBeInTheDocument();
	});

	it("names the authorization code grant's fields and the PKCE switch", () => {
		open({ ...CONFIG, grantType: "authorization_code" });

		expect(screen.getByLabelText("Authorization URL")).toBeInTheDocument();
		expect(screen.getByLabelText("Callback URL")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "PKCE" })).toBeInTheDocument();
	});

	it("names the two token switches by the text that wraps them", () => {
		open(CONFIG);
		expect(screen.getByRole("switch", { name: "Auto-fetch token" })).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Auto-refresh token" })).toBeInTheDocument();
	});
});
