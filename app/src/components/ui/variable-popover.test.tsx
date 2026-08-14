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
 * What the variable popover answers, and what it used to.
 *
 * Three defects, all of them things the component did rather than things it got
 * wrong by accident:
 *
 *   1. **It printed the value twice.** A "Current Value" block sat above an
 *      "Edit Value" input holding the same string, each with its own label and
 *      its own reveal button - roughly 90px restating what the editable field
 *      already said.
 *   2. **It could not say which environment.** A scope badge read "Environment"
 *      in an app whose whole point is having several of them, and `sourceName`
 *      had been declared on the type and populated by nothing for as long as it
 *      had existed.
 *   3. **An undefined variable was a dead end.** The popover said "Define it in
 *      Globals, an Environment, or Collection variables" and gave you no way to
 *      do any of that, for what is by far the most common reason to click a red
 *      token.
 *
 * The creation path has a trap worth a test of its own: `updateVariable` opens
 * each branch with a guard (`if (!activeEnvironmentId) return`), so writing to a
 * scope with no active target is a silent no-op. The picker must therefore offer
 * only what the caller says is writable - a "create in Environment" button with
 * no environment selected is a button that does nothing.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { VariablePopover } from "./variable-popover";
import { TooltipProvider } from "./tooltip";
import type { VariableOrigin } from "@/types";

/** Radix opens on pointerdown, which jsdom does not synthesise - use the key. */
function open() {
	fireEvent.keyDown(screen.getByRole("button", { name: /\{\{/ }), { key: "Enter" });
	return screen.getByRole("dialog");
}

function renderPopover(props: Partial<React.ComponentProps<typeof VariablePopover>> = {}) {
	const onValueChange = vi.fn();
	render(
		// The secret-reveal control is a TooltipIconButton, so even this popover
		// needs the provider the app mounts at its root.
		<TooltipProvider>
			<VariablePopover
				name="merchantId"
				varInfo={{ value: "mrc_8813", scope: "environment", sourceName: "Staging" }}
				resolved
				onValueChange={onValueChange}
				trigger={<span>{"{{merchantId}}"}</span>}
				{...props}
			/>
		</TooltipProvider>
	);
	return { onValueChange };
}

const origin = (
	o: Partial<VariableOrigin> & { scope: VariableOrigin["scope"] }
): VariableOrigin => ({
	value: "v",
	enabled: true,
	winner: false,
	...o,
});

describe("the value appears once", () => {
	it("puts it in the editable field and nowhere else", () => {
		renderPopover();
		const panel = open();
		// One element carries the value. Before, two did.
		expect(within(panel).getByDisplayValue("mrc_8813")).toBeInTheDocument();
		expect(within(panel).queryByText("mrc_8813")).not.toBeInTheDocument();
	});

	it("drops the two labels that introduced the duplicate", () => {
		renderPopover();
		const panel = open();
		expect(within(panel).queryByText("Current Value")).not.toBeInTheDocument();
		expect(within(panel).queryByText("Edit Value")).not.toBeInTheDocument();
	});

	it("gives a secret one field too, not two that disagree", () => {
		/*
		 * It was two: a read-only box printing a fixed eight dots, above a
		 * `type="password"` input printing the *real* value masked - so a
		 * two-character secret showed eight dots in one and two in the other.
		 * One field now, hidden until revealed.
		 */
		renderPopover({
			varInfo: {
				value: "sk_live_abc",
				scope: "environment",
				secret: true,
				sourceName: "Prod",
			},
		});
		const panel = open();
		expect(within(panel).getAllByRole("textbox")).toHaveLength(1);
		expect(within(panel).getByLabelText(/reveal value/i)).toBeInTheDocument();
	});

	it("masks at a fixed width, so the length cannot be counted off", () => {
		// The disclosure bug in the old version: one dot per character told you
		// exactly how long the secret was.
		renderPopover({ varInfo: { value: "ab", scope: "environment", secret: true } });
		const field = within(open()).getByRole("textbox") as HTMLInputElement;
		expect(field.value).toBe("••••••••");
		expect(field.value).not.toBe("••");
	});

	it("never puts a hidden secret's real value anywhere reachable", () => {
		/*
		 * `textContent` alone is not enough and a mutation proved it: putting the
		 * real string in the input's `value` leaves `textContent` clean while the
		 * secret is one DevTools inspection - or one autofill - away. Field
		 * values and every attribute are checked too.
		 */
		renderPopover({
			varInfo: { value: "sk_live_abcdef", scope: "environment", secret: true },
		});
		const panel = open();
		expect(document.body.textContent).not.toContain("sk_live_abcdef");
		for (const el of panel.querySelectorAll("input, textarea")) {
			expect((el as HTMLInputElement).value).not.toContain("sk_live");
		}
		expect(panel.innerHTML).not.toContain("sk_live_abcdef");
	});

	it("cannot be edited blind - the hidden field is read-only", () => {
		renderPopover({
			varInfo: { value: "sk_live_abc", scope: "environment", secret: true },
		});
		expect(within(open()).getByRole("textbox")).toHaveAttribute("readonly");
	});

	it("becomes an ordinary editable field once revealed", () => {
		renderPopover({
			varInfo: { value: "sk_live_abc", scope: "environment", secret: true },
		});
		const panel = open();
		fireEvent.click(within(panel).getByLabelText(/reveal value/i));
		const field = within(panel).getByRole("textbox") as HTMLInputElement;
		expect(field.value).toBe("sk_live_abc");
		expect(field).not.toHaveAttribute("readonly");
	});

	it("says a secret is not set rather than drawing dots for nothing", () => {
		renderPopover({ varInfo: { value: "", scope: "environment", secret: true } });
		const panel = open();
		expect((within(panel).getByRole("textbox") as HTMLInputElement).value).toBe("");
		expect(within(panel).getByPlaceholderText("not set")).toBeInTheDocument();
	});
});

describe("where the value came from", () => {
	it("names the environment rather than only its scope", () => {
		renderPopover();
		const panel = open();
		expect(within(panel).getByText("Staging")).toBeInTheDocument();
		expect(within(panel).getByText("Environment")).toBeInTheDocument();
	});

	it("shows the keys that already worked but were never mentioned", () => {
		// Real keycaps via the `Kbd` primitive - the footer sits on `bg-popover`,
		// which is the surface that primitive is built for.
		const panel = (renderPopover(), open());
		const caps = panel.querySelectorAll('[data-slot="kbd"]');
		expect([...caps].map((c) => c.textContent)).toEqual(["↵", "esc"]);
		expect(within(panel).getByText("save")).toBeInTheDocument();
		expect(within(panel).getByText("cancel")).toBeInTheDocument();
	});

	it("falls back to the old hint for a global, which has no source name", () => {
		renderPopover({ varInfo: { value: "x", scope: "global" } });
		expect(within(open()).getByText(/saves when you click away/)).toBeInTheDocument();
	});
});

describe("an undefined variable can define itself", () => {
	it("offers a value, a scope and a Create button", () => {
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: ["global", "environment"],
		});
		const panel = open();
		expect(within(panel).getByText("undefined")).toBeInTheDocument();
		expect(within(panel).getByRole("button", { name: "Create" })).toBeInTheDocument();
		// The dead-end sentence is gone when there is somewhere to write.
		expect(within(panel).queryByText(/Variable not defined/)).not.toBeInTheDocument();
	});

	it("creates into the highest-precedence writable scope by default", () => {
		const { onValueChange } = renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: ["global", "collection", "environment"],
		});
		const panel = open();
		fireEvent.change(within(panel).getByLabelText(/value for new variable/i), {
			target: { value: "stl_44921" },
		});
		fireEvent.click(within(panel).getByRole("button", { name: "Create" }));
		expect(onValueChange).toHaveBeenCalledWith("merchantId", "stl_44921", "environment");
	});

	it("creates into a scope the user picks instead", () => {
		const { onValueChange } = renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: ["global", "environment"],
		});
		const panel = open();
		fireEvent.click(within(panel).getByRole("button", { name: "Global" }));
		fireEvent.change(within(panel).getByLabelText(/value for new variable/i), {
			target: { value: "abc" },
		});
		fireEvent.click(within(panel).getByRole("button", { name: "Create" }));
		expect(onValueChange).toHaveBeenCalledWith("merchantId", "abc", "global");
	});

	it("never offers a scope that cannot be written", () => {
		// The silent-no-op guard. With no environment selected, `updateVariable`
		// returns without doing anything, so offering it would be a Create button
		// that appears to work and does not.
		renderPopover({ varInfo: null, resolved: false, writableScopes: ["global"] });
		const panel = open();
		expect(within(panel).getByRole("button", { name: "Global" })).toBeInTheDocument();
		expect(
			within(panel).queryByRole("button", { name: "Environment" })
		).not.toBeInTheDocument();
		expect(within(panel).queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
	});

	it("falls back to explaining, when nothing at all is writable", () => {
		renderPopover({ varInfo: null, resolved: false, writableScopes: [] });
		const panel = open();
		expect(within(panel).getByText(/Variable not defined/)).toBeInTheDocument();
		expect(within(panel).queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
	});
});

/**
 * A `data.*` name is unresolved for a reason no creation can fix: the namespace
 * (#402) is disjoint from the scopes, so both resolvers skip them and a variable
 * literally named `data.email` can never answer for the column. Offering Create
 * writes a dead definition and leaves the token exactly as it was.
 */
describe("a reserved data-namespace name", () => {
	/**
	 * Everything writable, so the refusal can only come from the name - an empty
	 * `writableScopes` withholds Create too, and would prove nothing.
	 */
	const unresolvedNamed = (name: string) =>
		renderPopover({
			name,
			varInfo: null,
			resolved: false,
			trigger: <span>{`{{${name}}}`}</span>,
			writableScopes: ["global", "collection", "environment"],
		});

	it("offers no way to create it", () => {
		unresolvedNamed("data.email");
		const panel = open();
		expect(within(panel).queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
		expect(within(panel).queryByLabelText(/value for new variable/i)).not.toBeInTheDocument();
		expect(
			within(panel).queryByRole("button", { name: "Environment" })
		).not.toBeInTheDocument();
	});

	it("says where the value comes from instead of calling it undefined", () => {
		unresolvedNamed("data.email");
		const panel = open();
		expect(within(panel).getByText(/Bound per iteration/)).toBeInTheDocument();
		expect(within(panel).queryByText(/Variable not defined/)).not.toBeInTheDocument();
		expect(within(panel).queryByText("undefined")).not.toBeInTheDocument();
		expect(within(panel).getByText("data")).toBeInTheDocument();
	});

	it("leaves the prefix alone, which names no column", () => {
		// `{{data.}}` is not in the namespace - it follows the ordinary
		// unknown-name rule, and a variable called `data.` would resolve.
		unresolvedNamed("data.");
		const panel = open();
		expect(within(panel).getByRole("button", { name: "Create" })).toBeInTheDocument();
	});
});

describe("why this value won", () => {
	const shadowed: VariableOrigin[] = [
		origin({ scope: "global", value: "http://localhost:8080" }),
		origin({ scope: "collection", sourceName: "Acme", value: "https://api.acme.io" }),
		origin({ scope: "environment", sourceName: "Staging", value: "mrc_8813", winner: true }),
	];

	it("lists the definitions that lost, and not the one that won", () => {
		renderPopover({ origins: shadowed });
		const panel = open();
		expect(within(panel).getByText("also defined")).toBeInTheDocument();
		expect(within(panel).getByText("http://localhost:8080")).toBeInTheDocument();
		expect(within(panel).getByText("https://api.acme.io")).toBeInTheDocument();
		// The winner is already the field above; repeating it here would be the
		// duplicate this whole change removed.
		expect(within(panel).queryByText("mrc_8813")).not.toBeInTheDocument();
	});

	it("stays out of the way when there is only one definition", () => {
		renderPopover({ origins: [origin({ scope: "environment", winner: true })] });
		expect(within(open()).queryByText("also defined")).not.toBeInTheDocument();
	});

	it("shows a disabled definition, which is the commonest surprise of all", () => {
		// "Why is this not the value I set?" is usually answered by a switch, not
		// by precedence - and a list built from the resolver's enabled-only map
		// could not say so.
		renderPopover({
			varInfo: { value: "global-token", scope: "global" },
			origins: [
				origin({ scope: "global", value: "global-token", winner: true }),
				origin({
					scope: "environment",
					sourceName: "Staging",
					value: "env-token",
					enabled: false,
				}),
			],
		});
		const panel = open();
		expect(within(panel).getByText("env-token")).toBeInTheDocument();
		expect(within(panel).getByText("off")).toBeInTheDocument();
	});

	it("masks a secret among the losers too", () => {
		renderPopover({
			origins: [
				origin({ scope: "global", value: "sk_live_leaked", secret: true }),
				origin({ scope: "environment", sourceName: "Staging", value: "x", winner: true }),
			],
		});
		const panel = open();
		expect(within(panel).queryByText("sk_live_leaked")).not.toBeInTheDocument();
		expect(within(panel).getByText("••••••••")).toBeInTheDocument();
	});
});
