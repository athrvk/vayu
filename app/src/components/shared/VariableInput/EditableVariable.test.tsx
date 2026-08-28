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
 * Hovering a `{{token}}` reads it; clicking edits it.
 *
 * Most clicks on a variable token were only ever to *see* what it resolved to,
 * and a click commits you to a popover you then have to dismiss. The tooltip
 * answers that without one.
 *
 * **The risk it introduces is the reason for this file.** `varInfo.secret`
 * gates the popover's value behind a deliberate reveal - a tooltip that printed
 * the resolved value on mouseover would walk straight around that gate, turning
 * a click-to-reveal into a mouseover. So the secret path is asserted here in
 * both directions: dots shown, value absent.
 *
 * jsdom fires no real pointer events, so `Tooltip.Root open` is set directly -
 * the assertion is about what the content renders, not about Radix's hover
 * timing, which is Radix's to test.
 *
 * Radix renders the content twice while open: the visible tooltip, plus a
 * visually-hidden copy for assistive tech. So these count matches rather than
 * demanding exactly one, and the secret test asserts against the whole tree -
 * which is the stronger assertion anyway, since it covers the hidden copy too.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";

// Radix only mounts tooltip content while open, and jsdom synthesises no hover.
// Forcing `open` is the narrowest way to reach the content this file is about.
vi.mock("@/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui")>();
	return {
		...actual,
		Tooltip: ({ children }: { children: React.ReactNode }) => (
			<actual.Tooltip open>{children}</actual.Tooltip>
		),
	};
});

const { default: EditableVariable } = await import("./EditableVariable");

function renderToken(props: Partial<React.ComponentProps<typeof EditableVariable>> = {}) {
	return render(
		<TooltipProvider>
			<EditableVariable
				name="merchantId"
				value="mrc_8813"
				scope="environment"
				resolved
				sourceName="Staging"
				variables={variableSupportStub()}
				{...props}
			/>
		</TooltipProvider>
	);
}

describe("the hover preview", () => {
	it("shows the resolved value without opening anything", () => {
		renderToken();
		expect(screen.getAllByText("mrc_8813").length).toBeGreaterThan(0);
		// No popover was opened to get it.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("names the environment it came from", () => {
		renderToken();
		expect(screen.getAllByText("Staging").length).toBeGreaterThan(0);
	});

	it("says so when the variable does not resolve", () => {
		renderToken({ resolved: false, value: "", sourceName: undefined });
		expect(screen.getAllByText("not defined").length).toBeGreaterThan(0);
	});

	it("distinguishes a defined-but-empty variable from an undefined one", () => {
		renderToken({ value: "" });
		expect(screen.getAllByText("empty").length).toBeGreaterThan(0);
		expect(screen.queryByText("not defined")).not.toBeInTheDocument();
	});
});

describe("secrets never appear on hover", () => {
	it("says it is a secret rather than drawing dots", () => {
		/*
		 * Dots on hover are the worst of both: they take the space of an answer,
		 * say nothing the token's own colour did not, and invite a second look to
		 * check you did not misread them. Whether it is *set* belongs in the
		 * popover, where revealing is a deliberate act.
		 */
		renderToken({ secret: true, value: "sk_live_abcdef" });
		expect(screen.getAllByText("secret").length).toBeGreaterThan(0);
		expect(screen.queryByText("••••••••")).not.toBeInTheDocument();
	});

	it("does not put the secret anywhere in the document", () => {
		// The whole point: the popover gates this behind a reveal button, and a
		// hover must not be a way around it.
		//
		// `document.body`, not the render container. Radix portals tooltip
		// content out of the container, so a container-scoped assertion here
		// passes whether or not the secret leaks - which it did, until a mutation
		// run printed the raw value and this test stayed green.
		renderToken({ secret: true, value: "sk_live_abcdef" });
		expect(document.body.textContent).not.toContain("sk_live_abcdef");
	});

	it("still names the source, which is not the secret", () => {
		renderToken({ secret: true, value: "sk_live_abcdef", sourceName: "Production" });
		expect(screen.getAllByText("Production").length).toBeGreaterThan(0);
	});
});

/**
 * Issue #1064. A bound row's column answers a bare name above every scope, and
 * the popover was taught to say so - but hovering and clicking are two readings
 * of the same token, and a tooltip still printing the environment's value made
 * one token say two things about one send.
 *
 * The paint is deliberately unchanged (D18): a shadowed bare name keeps the
 * variable's accent, and the explanation is what moves.
 */
describe("a bound row's column answers the token", () => {
	const withRow = variableSupportStub(
		{},
		{
			getVariableOrigins: () => [
				{
					scope: "environment",
					sourceName: "Staging",
					value: "staging@acme.io",
					enabled: true,
					winner: false,
				},
				{ scope: "row", value: "alice@acme.io", enabled: true, winner: true },
			],
		}
	);

	it("reads the row's cell on hover, not the definition it beat", () => {
		/*
		 * The mutation check: drop `boundRowValue` and the tooltip falls back to
		 * the resolved branch, which prints "staging@acme.io" - the value the send
		 * is not going to use, which is the whole defect.
		 */
		renderToken({ name: "email", value: "staging@acme.io", variables: withRow });
		expect(screen.getAllByText("alice@acme.io").length).toBeGreaterThan(0);
		expect(screen.queryByText("staging@acme.io")).not.toBeInTheDocument();
		expect(screen.getAllByText("Bound row").length).toBeGreaterThan(0);
	});

	it("answers a name no scope defines rather than calling it undefined", () => {
		const rowOnly = variableSupportStub(
			{},
			{
				getVariableOrigins: () => [
					{ scope: "row", value: "alice@acme.io", enabled: true, winner: true },
				],
			}
		);
		renderToken({ name: "email", value: "", resolved: false, variables: rowOnly });
		expect(screen.queryByText("not defined")).not.toBeInTheDocument();
		expect(screen.getAllByText("alice@acme.io").length).toBeGreaterThan(0);
	});

	it("leaves a token no row answers exactly as it was", () => {
		// With no row origin the tooltip must be the one this file already pins,
		// value and source name and all.
		renderToken();
		expect(screen.getAllByText("mrc_8813").length).toBeGreaterThan(0);
		expect(screen.queryByText("Bound row")).not.toBeInTheDocument();
	});

	it("never lets a row's cell reveal a secret variable's value", () => {
		// A cell is not a secret, but the variable it shadows may be - and the
		// tooltip must still not print the secret it is standing in front of.
		const shadowingSecret = variableSupportStub(
			{},
			{
				getVariableOrigins: () => [
					{
						scope: "environment",
						sourceName: "Prod",
						value: "sk_live_abcdef",
						secret: true,
						enabled: true,
						winner: false,
					},
					{ scope: "row", value: "alice@acme.io", enabled: true, winner: true },
				],
			}
		);
		renderToken({
			name: "apiKey",
			value: "sk_live_abcdef",
			secret: true,
			variables: shadowingSecret,
		});
		expect(document.body.textContent).not.toContain("sk_live_abcdef");
	});
});
