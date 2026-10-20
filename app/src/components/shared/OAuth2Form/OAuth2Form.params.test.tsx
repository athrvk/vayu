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
 * The three extra parameter tables sit in the Advanced section (#2536). Which
 * of them a grant shows, and what an emptied one leaves in the config, are the
 * form's to decide; the rows themselves are `ParamRowsEditor`'s.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2Config } from "@/types";
import OAuth2Form from "./OAuth2Form";

vi.mock("./TokenStatusRow", () => ({ default: () => null }));

const CONFIG: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://idp.test/token",
	clientId: "cid",
	tokenParams: [{ key: "audience", value: "api", enabled: true, sendAs: "url" }],
};

function open(value: OAuth2Config, onChange = vi.fn()) {
	render(
		<TooltipProvider>
			<OAuth2Form value={value} onChange={onChange} />
		</TooltipProvider>
	);
	fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
	return onChange;
}

const group = (name: string) => screen.queryByRole("group", { name });

describe("the extra parameter tables", () => {
	it("shows the authorization table for the authorization code grant only", () => {
		open({ ...CONFIG, grantType: "authorization_code" });
		expect(group("Authorization request parameters")).not.toBeNull();
		expect(group("Token request parameters")).not.toBeNull();
		expect(group("Refresh request parameters")).not.toBeNull();
	});

	it("hides the authorization table on a grant with no sign-in step", () => {
		open(CONFIG);
		expect(group("Authorization request parameters")).toBeNull();
		expect(group("Token request parameters")).not.toBeNull();
	});

	it("removes an emptied list from the config instead of storing []", () => {
		const onChange = open(CONFIG);

		const token = group("Token request parameters") as HTMLElement;
		fireEvent.click(within(token).getAllByRole("button", { name: "Remove row" })[0]);

		const written = onChange.mock.lastCall?.[0] as OAuth2Config;
		expect("tokenParams" in written).toBe(false);
		expect(written.clientId).toBe("cid");
	});

	it("writes the list beside the rest of the config when a row is typed", () => {
		const onChange = open({ ...CONFIG, tokenParams: undefined });

		const token = group("Token request parameters") as HTMLElement;
		fireEvent.change(within(token).getAllByPlaceholderText("Parameter")[0], {
			target: { value: "resource" },
		});

		expect(onChange.mock.lastCall?.[0]).toMatchObject({
			clientId: "cid",
			tokenParams: [{ key: "resource", value: "", enabled: true }],
		});
	});
});
