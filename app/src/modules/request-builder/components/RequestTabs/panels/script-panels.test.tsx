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
 * The script panel, rendered as both of its variants.
 *
 * `PreScriptPanel` and `TestScriptPanel` used to be two ~155-line files that a
 * normalised `diff` showed differing in three places, and each asked the next
 * reader to "change them together". This suite existed to make that safe by
 * running every assertion twice.
 *
 * They are one `ScriptPanel` now, so these cases no longer guard a one-sided
 * fix. They guard something else: that the extraction kept **three** distinct
 * bindings per variant - the `RequestState` field, and the two context keys for
 * inherited and legacy scripts. Crossing any of them renders a panel that looks
 * entirely correct, which is why each has a marker only it carries.
 *
 * Two defects the panels carried before that:
 *
 *   - The scope chips in the full variable list were hand-rolled as
 *     `<Badge variant="outline">{scope[0].toUpperCase()}</Badge>`, bypassing
 *     `VariableScopeBadge` - the primitive that owns the scope colours. Global,
 *     collection and environment therefore all rendered as the same colourless
 *     chip, in the one place a script author looks to tell them apart. The same
 *     class of bug as the autocomplete's grey global badge, in a surface the
 *     earlier fix did not reach because it does not use the primitive.
 *
 *   - Opening the full list *replaced* the "Names mentioned:" row (then
 *     labelled "Referenced:"). The button that
 *     promised more information removed the more useful half.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import ScriptPanel from "./script/ScriptPanel";

/** Monaco does not run under jsdom; nothing here tests the editor. */
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const SCRIPT = `pm.environment.get("token"); const u = "{{base_url}}"; pm.globals.get("run_id");`;

/*
 * The two fields hold *different* scripts. They used to hold the same string,
 * which meant a panel bound to the wrong field rendered identically and every
 * test below passed - the one defect the extraction could introduce was the
 * one thing nothing checked.
 */
const PRE_ONLY = "pm.environment.get('pre_only_marker');";
const POST_ONLY = "pm.environment.get('post_only_marker');";

const ALL_VARIABLES = {
	token: { value: "abc123", scope: "environment" as const },
	base_url: { value: "https://api.example.com", scope: "collection" as const },
	run_id: { value: "42", scope: "global" as const },
};

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ({
		request: {
			preRequestScript: `${SCRIPT} ${PRE_ONLY}`,
			testScript: `${SCRIPT} ${POST_ONLY}`,
			collectionId: null,
		},
		updateField: () => {},
		getAllVariables: () => ALL_VARIABLES,
		// Distinct per end of the run, so a panel reading the wrong context key
		// shows the other end's collection name / recorded script.
		inheritedPreScripts: [{ origin: "collection", id: "c1", name: "PreChain", script: "x" }],
		inheritedPostScripts: [{ origin: "collection", id: "c2", name: "PostChain", script: "x" }],
		legacyPreScript: "recorded_pre_script_marker",
		legacyPostScript: "recorded_post_script_marker",
	}),
}));

/**
 * `collectionId: null` above means InheritedScriptsNotice has nothing to
 * inherit, but it still calls `useCollectionAncestors`, which needs a
 * QueryClient this test never sets up. Mocked here, not tested here -
 * InheritedScriptsNotice.test.tsx covers its own behaviour.
 */
vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => [],
}));

/** Each variant, with the three markers only it should ever render. */
const PANELS = [
	["pre-request", "pre", "pre_only_marker", "PreChain", "recorded_pre_script_marker"],
	["tests", "post", "post_only_marker", "PostChain", "recorded_post_script_marker"],
] as const;

/** The compact scope chips inside the full variable list. */
function scopeChips(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>('[data-slot="badge"]')).filter((el) =>
		/^[GCE]$/.test(el.textContent?.trim() ?? "")
	);
}

function openFullList(container: HTMLElement) {
	const button = Array.from(container.querySelectorAll("button")).find((b) =>
		/all variables/i.test(b.textContent ?? "")
	);
	expect(button, "the panel should offer a full variable list").toBeTruthy();
	fireEvent.click(button!);
}

describe.each(PANELS)("%s panel", (_name, variant, ownMarker, ownChain, ownLegacy) => {
	const Panel = () => <ScriptPanel variant={variant} />;

	it("lists the variables the script references", () => {
		const { container } = render(<Panel />);
		expect(container.textContent).toContain("Names mentioned:");
		// One from pm.*.get(), one from a {{template}} - both scanners run.
		expect(container.textContent).toContain("token");
		expect(container.textContent).toContain("base_url");
	});

	it("keeps the referenced list visible once the full list opens", () => {
		const { container } = render(<Panel />);
		openFullList(container);

		expect(container.textContent).toContain("Names mentioned:");
	});

	it("shows every variable in scope once the full list opens", () => {
		const { container } = render(<Panel />);
		expect(scopeChips(container)).toHaveLength(0);

		openFullList(container);
		expect(scopeChips(container)).toHaveLength(3);
	});

	it("gives each scope its own colour, via the shared primitive", () => {
		const { container } = render(<Panel />);
		openFullList(container);

		const classes = scopeChips(container).map((el) => el.className);
		expect(classes).toHaveLength(3);

		// The defect: a hand-rolled `variant="outline"` chip paints no scope
		// colour, so all three were identical. Distinctness is the assertion -
		// it holds whatever the individual hues are.
		expect(new Set(classes).size).toBe(3);
		for (const cls of classes) {
			expect(cls).toMatch(/\btext-scope-(global|collection|environment)\b/);
		}
	});

	it("reads its own field and not the other panel's", () => {
		/*
		 * The one defect the extraction could introduce. Both fields hold a
		 * marker only they contain, so a panel wired to the wrong one names the
		 * other's marker in its chip row.
		 */
		const { container } = render(<Panel />);
		const other = ownMarker === "pre_only_marker" ? "post_only_marker" : "pre_only_marker";

		expect(container.textContent).toContain(ownMarker);
		expect(container.textContent).not.toContain(other);
	});

	it("takes its inherited scripts and legacy script from its own end of the run", () => {
		/*
		 * Three bindings, not one. The field is the obvious one to cross; the
		 * two context keys are the quiet ones, and nothing checked them - a
		 * `post` panel reading `inheritedPreScripts` listed the wrong
		 * collections and every other test still passed.
		 */
		const { container } = render(<Panel />);
		const otherChain = ownChain === "PreChain" ? "PostChain" : "PreChain";
		const otherLegacy =
			ownLegacy === "recorded_pre_script_marker"
				? "recorded_post_script_marker"
				: "recorded_pre_script_marker";

		expect(container.textContent).toContain(ownChain);
		expect(container.textContent).not.toContain(otherChain);
		expect(container.textContent).toContain(ownLegacy);
		expect(container.textContent).not.toContain(otherLegacy);
	});

	/*
	 * `--muted` is the one surface where no border token works: it sits between
	 * `--border` (L 10%) and `--border-strong` (L 18%) in dark, so the old
	 * `bg-muted/50 ... border border-input` drew an edge that was wrong in one
	 * theme or the other. `surface-sunken` declares a `--rule` that reads on it.
	 *
	 * Only the *declaration* is checkable here - a `border-rule` under no
	 * declared surface silently falls back to the invisible default, so
	 * asserting `border-rule` alone proves nothing, and the colour it resolves
	 * to is a computed-style question jsdom cannot answer.
	 */
	/*
	 * A pre-request script can now change the outgoing request, and none of the
	 * rules that govern it are visible from a snippet: that the object is
	 * authoritative, that it beats the Auth tab, that a bad value refuses the
	 * whole edit. Leaving those only in `docs/engine/scripting.md` puts them
	 * where the person writing the script is not - so the panel carries them,
	 * and this checks it still does.
	 */
	it("tells the reader what its scripts can and cannot change", () => {
		const { container } = render(<Panel />);
		const text = container.textContent ?? "";

		// Both variants render notes at all - an empty list would pass every
		// substring check below by never contradicting one.
		expect(container.querySelectorAll("ul li").length).toBeGreaterThan(0);

		if (variant === "pre") {
			expect(text).toContain("what is actually sent");
			expect(text).toMatch(/wins over the Auth tab|beats the/i);
			expect(text).toMatch(/case-sensitive/i);
			// The failure path is the half a user only meets when it bites.
			expect(text).toMatch(/rejects the whole edit/i);
			expect(text).toMatch(/load tests do not run pre-request scripts/i);
		} else {
			// The other half of the contract: writing here is a no-op.
			expect(text).toMatch(/writing to it does nothing/i);
		}
	});

	/*
	 * The quick reference is copy-paste bait: it sits next to the editor and a
	 * script author types what it shows. It suggested
	 * `pm.response.headers.get("Content-Type")` for as long as the panel had
	 * existed while the runtime had no such member (#182), so the line was
	 * pulled; #185 added `get`/`has` to both header objects and it went back.
	 * These now pin the restored form, so dropping the runtime methods without
	 * pulling the suggestion again fails here.
	 */
	it("suggests the header reads the runtime implements", () => {
		const { container } = render(<Panel />);
		const text = container.textContent ?? "";

		if (variant === "post") {
			expect(text).toContain('pm.response.headers.get("Content-Type")');
			// The distinction the snippet cannot show: get() is case-insensitive,
			// indexing is not, and the engine lower-cases what it parses.
			expect(text).toMatch(/lower-cases every key/i);
			expect(text).toMatch(/case-insensitive/i);
		} else {
			// The pre-request half: the mutators, and the one that refuses a
			// name it already holds.
			expect(text).toContain("pm.request.headers.upsert(");
			expect(text).toMatch(/add.*throws/is);
		}
	});

	/*
	 * The quick reference is a handful of lines and the notes are a handful of
	 * rules; everything else about the `pm` API lives in the scripting guide,
	 * which a script author had no way to reach from the panel they write
	 * scripts in. It has to be the keyed channel: the renderer cannot open an
	 * arbitrary URL, and an anchor would open an Electron window instead of the
	 * browser.
	 */
	describe("the scripting docs link", () => {
		function docsLink(container: HTMLElement): HTMLButtonElement | undefined {
			return Array.from(container.querySelectorAll("button")).find((b) =>
				/scripting docs/i.test(b.textContent ?? "")
			);
		}

		it("offers the guide and opens it through the keyed link channel", () => {
			const openAppLink = vi.fn();
			vi.stubGlobal("electronAPI", {
				openAppLink,
			} as unknown as Window["electronAPI"]);

			const { container } = render(<Panel />);
			const link = docsLink(container);
			expect(link, "both script panels should link the scripting guide").toBeTruthy();

			fireEvent.click(link!);
			expect(openAppLink).toHaveBeenCalledWith("scripting");

			vi.unstubAllGlobals();
		});

		it("does not throw when the preload bridge is absent", () => {
			vi.stubGlobal("electronAPI", undefined);

			const { container } = render(<Panel />);
			expect(() => fireEvent.click(docsLink(container)!)).not.toThrow();

			vi.unstubAllGlobals();
		});
	});

	describe("the sunken slabs", () => {
		it("declares the surface its rule reads from", () => {
			const { container } = render(<Panel />);
			openFullList(container);

			const slabs = container.querySelectorAll(".surface-sunken");
			expect(
				slabs.length,
				"the full variable list, the quick reference, and the legacy script"
			).toBe(3);
			for (const slab of slabs) {
				expect(slab.className).toContain("border-rule");
			}
		});

		it("leaves no border token on a muted surface", () => {
			const { container } = render(<Panel />);
			openFullList(container);

			expect(container.innerHTML).not.toContain("border-input");
			expect(container.innerHTML).not.toContain("bg-muted/50");
		});
	});
});
