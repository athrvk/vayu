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
 * The Σ peek used to resolve the row's text inline, in the component body, on
 * every render. A dynamic variable like `{{$randomInt}}` generates a fresh
 * value on every call (`lib/dynamic-variables.ts`'s own contract), so the peek
 * answered with a different number each time it was opened - and "peek"
 * promises the value *this row* stands for, not a new draw from the generator.
 *
 * **The remount is the case that matters, and a `useMemo` cannot answer it.**
 * Params, Headers and both body tables live behind a `TabsContent` that Radix
 * unmounts (`RequestTabs/index.tsx` force-mounts Body and Elements only), so a
 * glance at another tab destroys every row and builds new ones - and a per-row
 * memo could not be written in the first place, since the memo would belong to
 * the row it dies with. `stableRowField` is the module-scope cache from
 * `lib/dynamic-variable-cache.ts`, keyed by row id and field.
 *
 * The value itself is read out of the open tooltip rather than counted, because
 * what the user complained about is the number on screen; the re-render case is
 * pinned by call count as well, since a render's own timing cannot otherwise be
 * asserted against.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { VariableSupport } from "@/types";
import KeyValueRow from "./KeyValueRow";

const VALUE = "id-{{$randomInt}}";

afterEach(cleanup);

/**
 * A resolver that behaves the way the dynamic-variable table does: every call
 * hands back a *different* value for the same input. Anything that resolves
 * twice therefore shows two different strings, which is the defect itself.
 */
function makeRerollingResolver() {
	let n = 0;
	return vi.fn((input: string) => input.replace("{{$randomInt}}", String(++n)));
}

function renderRow(scope: VariableSupport, id: string, value: string) {
	return render(
		// `delayDuration={0}`: the peek is opened below to read what it says, and
		// Radix's 700ms default would spend most of the case's budget waiting.
		<TooltipProvider delayDuration={0}>
			<KeyValueRow
				item={{ id, key: "X-Trace", value, enabled: true }}
				keyPlaceholder="Header"
				valuePlaceholder="Value"
				showResolved={true}
				allowDisable={true}
				readOnly={false}
				variables={scope}
				onUpdate={() => {}}
				onPickFile={() => {}}
				onToggleKind={() => {}}
				onRemove={() => {}}
			/>
		</TooltipProvider>
	);
}

/** Open the Σ peek and read what it says. */
async function peekText(container: HTMLElement): Promise<string> {
	const trigger = container.querySelector<HTMLElement>('[aria-label^="Resolved value of"]');
	expect(trigger).not.toBeNull();
	// The pointer event Radix actually listens for on a tooltip trigger.
	fireEvent.pointerMove(trigger!, { pointerType: "mouse" });
	const tooltip = await screen.findByRole("tooltip");
	return tooltip.textContent ?? "";
}

describe("the resolved-value peek", () => {
	it("says the same thing when it is opened again after a tab switch", async () => {
		// The repro: Headers → Params → Headers. Radix unmounts an inactive
		// `TabsContent` and these panels are not force-mounted, so the second
		// visit is a *new row instance*, not a re-render - which is why a memo
		// could not hold this and the module-scope cache can.
		const resolveString = makeRerollingResolver();
		const scope = variableSupportStub({}, { resolveString });

		const first = renderRow(scope, "row_remount", VALUE);
		const before = await peekText(first.container);
		// Sanity: the peek really carries a generated value, not the raw token.
		expect(before).toMatch(/^X-Trace: id-\d+$/);
		first.unmount();

		const second = renderRow(scope, "row_remount", VALUE);
		expect(await peekText(second.container)).toBe(before);
	});

	it("does not re-resolve the row on a re-render with nothing about it changed", () => {
		const resolveString = makeRerollingResolver();
		const scope = variableSupportStub({}, { resolveString });

		const { rerender, container } = renderRow(scope, "row_rerender", VALUE);
		const callsForValue = () => resolveString.mock.calls.filter(([s]) => s === VALUE).length;
		expect(callsForValue()).toBe(1);

		// A re-render triggered by something unrelated to this row - a sibling
		// row's keystroke, a store update elsewhere - must not draw again.
		rerender(
			<TooltipProvider delayDuration={0}>
				<KeyValueRow
					item={{ id: "row_rerender", key: "X-Trace", value: VALUE, enabled: true }}
					keyPlaceholder="Header"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
					readOnly={false}
					variables={scope}
					onUpdate={() => {}}
					onPickFile={() => {}}
					onToggleKind={() => {}}
					onRemove={() => {}}
				/>
			</TooltipProvider>
		);
		expect(callsForValue()).toBe(1);
		expect(container.querySelector('[aria-label^="Resolved value of"]')).not.toBeNull();
	});

	it("draws again once the row's text actually changes", async () => {
		const resolveString = makeRerollingResolver();
		const scope = variableSupportStub({}, { resolveString });

		const first = renderRow(scope, "row_edit", VALUE);
		const before = await peekText(first.container);
		first.unmount();

		const edited = `${VALUE}-x`;
		const second = renderRow(scope, "row_edit", edited);
		expect(await peekText(second.container)).not.toBe(before);
	});

	it("gives two rows their own value rather than one keyed by the text", async () => {
		// Byte-identical templates on two different rows. Keying the cache on the
		// text alone would collapse them, which is the collision the resolver
		// conformance fixture forbids for two distinct occurrences.
		const resolveString = makeRerollingResolver();
		const scope = variableSupportStub({}, { resolveString });

		const a = renderRow(scope, "row_a", VALUE);
		const aText = await peekText(a.container);
		a.unmount();

		const b = renderRow(scope, "row_b", VALUE);
		expect(await peekText(b.container)).not.toBe(aText);
	});
});
