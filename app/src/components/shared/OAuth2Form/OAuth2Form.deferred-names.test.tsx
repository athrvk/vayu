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
 * The form does not know which names a pre-request script sets (#2742): its host
 * does, and hands them down for the token row, which reports no token state for
 * a config the script will change. The form's one job is to pass them on.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2Config } from "@/types";
import OAuth2Form from "./OAuth2Form";

vi.mock("./TokenStatusRow", () => ({
	default: ({ deferredNames }: { deferredNames?: readonly string[] }) => (
		<div data-testid="token-row" data-deferred={(deferredNames ?? []).join(",")} />
	),
}));

const CONFIG: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://idp.test/token",
	clientId: "{{clientId}}",
};

function renderForm(deferredNames?: readonly string[]) {
	render(
		<TooltipProvider>
			<OAuth2Form value={CONFIG} onChange={() => {}} deferredNames={deferredNames} />
		</TooltipProvider>
	);
}

describe("OAuth2Form's token row", () => {
	it("is told which names a pre-request script sets", () => {
		renderForm(["clientId"]);

		expect(screen.getByTestId("token-row")).toHaveAttribute("data-deferred", "clientId");
	});

	it("is told nothing by a host that cannot know, such as the collection editor", () => {
		renderForm();

		expect(screen.getByTestId("token-row")).toHaveAttribute("data-deferred", "");
	});
});
