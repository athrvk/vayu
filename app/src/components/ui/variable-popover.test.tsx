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

	/**
	 * The defect this rule exists to prevent, at the width the card actually
	 * has: a source name that shares its row with something unshrinkable is a
	 * source name the reader cannot finish (issue #1320, and #1195 before it in
	 * the tooltips). Mutation check: put the name back in a flex row beside the
	 * keycaps - `<span className="truncate">` and a `shrink-0` sibling - and the
	 * class assertions below fail.
	 */
	const LONG_SOURCE = "Shopify QA - expiring tokens, do not use for demos";

	it("shows a long source name whole, on a line of its own", () => {
		renderPopover({
			varInfo: { value: "x", scope: "environment", sourceName: LONG_SOURCE },
		});
		const source = within(open()).getByText(LONG_SOURCE);
		expect(source.className).not.toContain("truncate");
		// The whole line, not just the name: a truncating ancestor clips it too.
		const line = source.parentElement as HTMLElement;
		expect(line.textContent).toBe(`in ${LONG_SOURCE}`);
		expect(line.className).not.toContain("truncate");
		expect(line.querySelector(".shrink-0")).toBeNull();
		// The full name is reachable without measuring the card.
		expect(line).toHaveAttribute("title", LONG_SOURCE);
	});

	it("names the scope where there is no source name, so the line never goes missing", () => {
		// A global has nothing to name. The line stays, holding the scope word,
		// rather than the card changing height between one variable and the next.
		renderPopover({ varInfo: { value: "x", scope: "global" } });
		// The badge beside the name says "Global" too, so read the source line
		// itself rather than the first element carrying the word.
		const line = within(open()).getByText("Global", { selector: "p > span" });
		expect(line.parentElement?.textContent).toBe("in Global");
	});

	it("states what saves the edit, instead of keycaps that pointed at it", () => {
		const panel = (renderPopover(), open());
		expect(panel.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);
		expect(within(panel).getByText(/Saves when you click away\. Esc discards\./)).toBeInTheDocument();
	});

	it("leaves that sentence out of manual mode, which saves on a button", () => {
		renderPopover({ saveMode: "manual" });
		const panel = open();
		expect(within(panel).queryByText(/Saves when you click away/)).not.toBeInTheDocument();
		expect(within(panel).getByRole("button", { name: "Save" })).toBeInTheDocument();
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

/**
 * Issue #1083. The list above exists for exactly one question - "why is this not
 * the value I set?" - and could not reach the shape that asks it loudest.
 *
 * A name whose *only* definition is switched off has no winner, so it does not
 * resolve, so it arrived in the create branch: offered a form to define a name
 * that is already defined and one toggle from answering, with nothing on screen
 * saying so. Acting on that offer writes a second definition which shadows
 * nothing and leaves the first one off.
 */
describe("a name whose only definition is switched off", () => {
	const onlyDisabled: VariableOrigin[] = [
		origin({ scope: "environment", sourceName: "Staging", value: "env-token", enabled: false }),
	];

	it("lists that definition, with its off badge, where nothing is writable", () => {
		// Mutation check: put `ShadowedBy` back inside the resolved branch, or
		// restore the `origins.length < 2` gate, and all three of these vanish.
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: [],
			origins: onlyDisabled,
		});
		const panel = open();
		expect(within(panel).getByText("also defined")).toBeInTheDocument();
		expect(within(panel).getByText("env-token")).toBeInTheDocument();
		expect(within(panel).getByText("off")).toBeInTheDocument();
	});

	it("says the definitions are off rather than telling you to go and define it", () => {
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: [],
			origins: onlyDisabled,
		});
		const panel = open();
		expect(within(panel).getByText(/every definition is switched off/)).toBeInTheDocument();
		expect(within(panel).queryByText(/Variable not defined/)).not.toBeInTheDocument();
	});

	it("still offers to create, and says what the offer is doing", () => {
		// The offer stays: this popover writes values, not enabled flags, so it
		// cannot present the switch that would be the better answer. What it can
		// stop doing is offering in silence.
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: ["global"],
			origins: onlyDisabled,
		});
		const panel = open();
		expect(within(panel).getByRole("button", { name: "Create" })).toBeInTheDocument();
		expect(within(panel).getByText(/already defined below, switched off/)).toBeInTheDocument();
		expect(within(panel).getByText("off")).toBeInTheDocument();
	});

	it("counts them when there is more than one", () => {
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: ["global"],
			origins: [
				origin({ scope: "global", value: "global-token", enabled: false }),
				...onlyDisabled,
			],
		});
		const panel = open();
		expect(within(panel).getByText(/already defined 2 times below/)).toBeInTheDocument();
		expect(within(panel).getByText("global-token")).toBeInTheDocument();
		expect(within(panel).getByText("env-token")).toBeInTheDocument();
	});

	it("does not promise a row-less send a definition that is switched off", () => {
		/*
		 * The list reaching the unresolved states brought the bound-row note with
		 * it, into a state it had never been drawn in: "the definition above still
		 * resolves on a send that carries no row" is the one thing an off
		 * definition does not do. Dropping the pick here leaves the token red, and
		 * that is what the reader needs to be told.
		 */
		renderPopover({
			varInfo: null,
			resolved: false,
			writableScopes: [],
			origins: [...onlyDisabled, origin({ scope: "row", value: "row-token", winner: true })],
		});
		const panel = open();
		expect(
			within(panel).getByText(/a send that carries no row resolves nothing/)
		).toBeInTheDocument();
		expect(within(panel).queryByText(/still resolves on a send/)).not.toBeInTheDocument();
	});

	it("shows no list for a name nothing defines anywhere", () => {
		// The companion to the first case: the gate moved from counting entries
		// to asking whether any of them is not the winner, and a name with no
		// entries at all must still say nothing rather than draw an empty list.
		renderPopover({ varInfo: null, resolved: false, writableScopes: ["global"], origins: [] });
		const panel = open();
		expect(within(panel).queryByText("also defined")).not.toBeInTheDocument();
		expect(within(panel).getByRole("button", { name: "Create" })).toBeInTheDocument();
	});
});

/**
 * Issue #1064. #1007 put a bound row's columns above every scope and #1062 made
 * the *preview* say so, but the popover - the one surface whose entire job is
 * "why is this the value" - still explained the environment's definition while
 * the send was about to use the row's cell.
 *
 * The row is not a definition: nobody wrote it, nothing can edit it, and it
 * disappears when the pick is dropped. So it is listed as the origin rather than
 * replacing the editable field, which still holds the variable, because the
 * variable is still the thing a reader can act on.
 */
describe("a bound data row outranks every definition", () => {
	/** Lowest precedence first, as the resolver hands them over. */
	const withRow: VariableOrigin[] = [
		origin({ scope: "environment", sourceName: "Staging", value: "staging@acme.io" }),
		origin({ scope: "row", value: "alice@acme.io", winner: true }),
	];

	it("names the row as the origin and strikes the definition it beat", () => {
		renderPopover({ origins: withRow });
		const panel = open();

		expect(within(panel).getByText("bound data row")).toBeInTheDocument();
		expect(within(panel).getByText("Bound row")).toBeInTheDocument();

		/*
		 * The mutation check. Drop the row origin from `ShadowedBy` - or let it
		 * fall through to the ordinary loser list - and the row's cell either
		 * vanishes or arrives struck through, which is the popover claiming the
		 * send will not use the one value it will.
		 */
		const rowValue = within(panel).getByText("alice@acme.io");
		expect(rowValue.className).not.toContain("line-through");

		const beaten = within(panel).getByText("staging@acme.io");
		expect(beaten.className).toContain("line-through");
	});

	it("says what the shadowed definition is still good for", () => {
		// Not the `data.*` sentence: that one says defining a variable of this
		// name would change nothing, which is false for a bare column.
		renderPopover({ origins: withRow });
		expect(
			within(open()).getByText(/still resolves on a send that carries no row/)
		).toBeInTheDocument();
	});

	it("reads exactly as it did before when no row is bound", () => {
		// The tier is opt-in at the resolver, so a popover that never sees a row
		// origin must be untouched by any of this.
		renderPopover({
			origins: [
				origin({ scope: "environment", sourceName: "Staging", value: "x", winner: true }),
				origin({ scope: "global", value: "http://localhost:8080" }),
			],
		});
		const panel = open();
		expect(within(panel).getByText("also defined")).toBeInTheDocument();
		expect(within(panel).queryByText("bound data row")).not.toBeInTheDocument();
		expect(within(panel).queryByText("Bound row")).not.toBeInTheDocument();
	});

	it("does not offer to create a variable as though the name were unanswered", () => {
		/*
		 * The realistic prop shape, and the one the first cut of this change
		 * missed: `EditableVariable` always passes an `onValueChange` and a
		 * `writableScopes` that has globals in it, so `canCreate` wins the render
		 * ternary and the create form is what a reader actually sees. Creating is
		 * still worth offering - the variable answers every row-less send - but a
		 * form that says nothing about the row implies the token is unanswered,
		 * which is the same wrong claim in a different shape.
		 */
		renderPopover({
			name: "email",
			varInfo: null,
			resolved: false,
			trigger: <span>{"{{email}}"}</span>,
			writableScopes: ["global", "environment"],
			origins: [origin({ scope: "row", value: "alice@acme.io", winner: true })],
		});
		const panel = open();
		expect(within(panel).getByText("Create")).toBeInTheDocument();
		expect(
			within(panel).getByText(/The bound row already answers this name/)
		).toBeInTheDocument();
		expect(within(panel).getByText("alice@acme.io")).toBeInTheDocument();
	});

	it("does not chip a row-answered name as undefined", () => {
		// The chip is a separate claim from the body text, and destructive red
		// there says the same false thing: that this token reaches the server
		// with its braces on.
		renderPopover({
			name: "email",
			varInfo: null,
			resolved: false,
			trigger: <span>{"{{email}}"}</span>,
			writableScopes: ["global"],
			origins: [origin({ scope: "row", value: "alice@acme.io", winner: true })],
		});
		const panel = open();
		expect(within(panel).queryByText("undefined")).not.toBeInTheDocument();
		expect(within(panel).getByText("row")).toBeInTheDocument();
	});

	it("still chips a genuinely undefined name as undefined", () => {
		// The mutation check for the pair above: with no row answering, the red
		// chip is correct and must survive.
		renderPopover({
			name: "email",
			varInfo: null,
			resolved: false,
			trigger: <span>{"{{email}}"}</span>,
			writableScopes: ["global"],
		});
		const panel = open();
		expect(within(panel).getByText("undefined")).toBeInTheDocument();
		expect(within(panel).queryByText("row")).not.toBeInTheDocument();
	});

	it("stops calling a name the row answers an undefined variable", () => {
		/*
		 * The destructive red states a token that reaches the server with its
		 * braces still on. A row carrying this column is precisely the case where
		 * it does not - the file declared no such column, so the painter never
		 * diverted it, and the popover was the only thing left saying anything.
		 */
		renderPopover({
			name: "email",
			varInfo: null,
			resolved: false,
			trigger: <span>{"{{email}}"}</span>,
			origins: [origin({ scope: "row", value: "alice@acme.io", winner: true })],
		});
		const panel = open();
		expect(within(panel).queryByText(/Variable not defined/)).not.toBeInTheDocument();
		expect(within(panel).getByText(/Answered by the bound data row/)).toBeInTheDocument();
		expect(within(panel).getByText(/carries no row/)).toBeInTheDocument();
	});
});

describe("an Enter that only commits an IME buffer", () => {
	it("saves on a plain Enter and not on a composition commit", () => {
		// The keystroke an IME uses to commit its composition reaches the handler
		// as an ordinary Enter keydown, so without the guard the popover saved
		// the half-composed value on the first one.
		const { onValueChange } = renderPopover({ saveMode: "manual" });
		const field = within(open()).getByLabelText("Value of merchantId");

		fireEvent.keyDown(field, { key: "Enter", isComposing: true });
		expect(onValueChange).not.toHaveBeenCalled();

		fireEvent.keyDown(field, { key: "Enter" });
		expect(onValueChange).toHaveBeenCalledWith("merchantId", "mrc_8813", "environment");
	});
});
