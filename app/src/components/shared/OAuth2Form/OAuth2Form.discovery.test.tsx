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
 * Discovery from a server URL (#3766): the switch, what a sign-in writes into
 * the stored config, and the members it wrote showing as found rather than
 * typed until Discover again clears them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2Config } from "@/types";
import OAuth2Form from "./OAuth2Form";

const row = vi.hoisted(() => ({
	props: null as null | {
		resolvedConfig: OAuth2Config;
		onDiscovered?: (values: Record<string, string>) => void;
	},
}));
vi.mock("./TokenStatusRow", () => ({
	default: (props: NonNullable<typeof row.props>) => {
		row.props = props;
		return null;
	},
}));

const AUTH_CODE: OAuth2Config = {
	grantType: "authorization_code",
	accessTokenUrl: "",
	clientId: "",
};

const DISCOVERED: OAuth2Config = {
	...AUTH_CODE,
	discoverUrl: "https://mcp.example.com/mcp",
	authorizationUrl: "https://auth.example.com/authorize",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "registered",
	scope: "typed scope",
	discoveredFields: ["authorizationUrl", "accessTokenUrl", "clientId"],
};

function open(value: OAuth2Config, onChange = vi.fn()) {
	render(
		<TooltipProvider>
			<OAuth2Form value={value} onChange={onChange} />
		</TooltipProvider>
	);
	return onChange;
}

const discoverSwitch = () => screen.getByRole("switch", { name: "Discover from the server URL" });

beforeEach(() => {
	row.props = null;
});

describe("the discovery switch", () => {
	it("is offered for the authorization code grant only", () => {
		open({ ...AUTH_CODE, grantType: "client_credentials" });

		expect(screen.queryByRole("switch", { name: "Discover from the server URL" })).toBeNull();
	});

	it("is dropped with its found values when another grant is chosen, since no switch would show it", () => {
		const onChange = open(DISCOVERED);

		fireEvent.click(screen.getByRole("combobox", { name: "Grant type" }));
		fireEvent.click(screen.getByRole("option", { name: "Client credentials" }));

		const written = onChange.mock.lastCall?.[0] as OAuth2Config;
		expect(written.grantType).toBe("client_credentials");
		expect("discoverUrl" in written).toBe(false);
		expect("discoveredFields" in written).toBe(false);
		expect(written.clientId).toBe("registered");
	});

	it("turns discovery on with no URL typed yet, and shows the server URL field", () => {
		const onChange = open(AUTH_CODE);

		fireEvent.click(discoverSwitch());

		expect(onChange.mock.lastCall?.[0]).toEqual({ ...AUTH_CODE, discoverUrl: "" });
	});

	it("keeps what was found as ordinary values when turned off", () => {
		const onChange = open(DISCOVERED);

		fireEvent.click(discoverSwitch());

		const written = onChange.mock.lastCall?.[0] as OAuth2Config;
		expect("discoverUrl" in written).toBe(false);
		expect("discoveredFields" in written).toBe(false);
		expect(written.clientId).toBe("registered");
	});

	it("resolves the server URL for the token row, so a variable in it reaches the sign-in", () => {
		render(
			<TooltipProvider>
				<OAuth2Form
					value={{ ...AUTH_CODE, discoverUrl: "{{mcp}}/mcp" }}
					onChange={vi.fn()}
					resolveString={(s) => s.replace("{{mcp}}", "https://mcp.example.com")}
				/>
			</TooltipProvider>
		);

		expect(row.props?.resolvedConfig.discoverUrl).toBe("https://mcp.example.com/mcp");
	});
});

describe("what discovery found", () => {
	it("shows each member it wrote read-only, and a typed one editable", () => {
		open(DISCOVERED);

		const clientId = screen.getByLabelText("Client ID");
		expect(clientId).toHaveAttribute("readonly");
		expect(clientId).toHaveValue("registered");
		expect(screen.getByLabelText("Access token URL")).toHaveAttribute("readonly");
		expect(screen.getByLabelText("Scope")).not.toHaveAttribute("readonly");
		expect(
			screen.getByText(
				/Found by discovery: Authorization URL, Access token URL and Client ID/
			)
		).toBeInTheDocument();
	});

	it("is cleared by Discover again, typed members kept", () => {
		const onChange = open(DISCOVERED);

		fireEvent.click(screen.getByRole("button", { name: "Discover again" }));

		expect(onChange.mock.lastCall?.[0]).toEqual({
			...AUTH_CODE,
			discoverUrl: DISCOVERED.discoverUrl,
			scope: "typed scope",
		});
	});

	it("is written into the config once a sign-in hands it back", () => {
		const value = { ...AUTH_CODE, discoverUrl: "https://mcp.example.com/mcp" };
		const onChange = open(value);

		row.props?.onDiscovered?.({
			accessTokenUrl: "https://auth.example.com/token",
			clientId: "registered",
		});

		expect(onChange).toHaveBeenCalledWith({
			...value,
			accessTokenUrl: "https://auth.example.com/token",
			clientId: "registered",
			discoveredFields: ["accessTokenUrl", "clientId"],
		});
	});
});
