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
 * A row naming a variable a pre-request script sets at send (#2762).
 *
 * The builder's resolver leaves such a token written, so resolving changes
 * nothing and the row would lose its sigma - the one way to the sentence that
 * says why the token is still there. The row therefore reads the names itself
 * and keeps the marker; what the peek prints is the resolver's, which the
 * request builder's provider owns (`RequestBuilderProvider.deferred-previews`).
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import type { VariableSupport } from "@/types";
import KeyValueRow from "./KeyValueRow";

afterEach(cleanup);

/** A resolver that leaves every field as written, as one holding only deferred names does. */
const leavesAsWritten: VariableSupport["resolveField"] = (input) => ({
	text: input,
	refusals: [],
});

function renderRow(scope: VariableSupport, id: string, key: string, value: string) {
	return render(
		<TooltipProvider delayDuration={0}>
			<KeyValueRow
				item={{ id, key, value, enabled: true }}
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

async function peekText(label: string): Promise<string> {
	fireEvent.pointerMove(screen.getByRole("button", { name: `Resolved value of ${label}` }), {
		pointerType: "mouse",
	});
	return (await screen.findByRole("tooltip")).textContent ?? "";
}

const PEEK = /Resolved value of/;

describe("the resolved-value peek of a row naming a deferred variable", () => {
	it("keeps its marker though resolving changed nothing, and says a script sets the name", async () => {
		const scope = variableSupportStub(
			{},
			{ resolveField: leavesAsWritten, deferredVariables: ["token"] }
		);
		renderRow(scope, "row_deferred", "Authorization", "Bearer {{token}}");

		const text = await peekText("Authorization");
		expect(text).toContain("Authorization: Bearer {{token}}");
		expect(text).toContain("{{token}} is set by a pre-request script at send.");
	});

	it("names a deferred variable in the key as well as in the value", async () => {
		const scope = variableSupportStub(
			{},
			{ resolveField: leavesAsWritten, deferredVariables: ["name", "token"] }
		);
		renderRow(scope, "row_key", "{{name}}", "{{token}}");

		expect(await peekText("{{name}}")).toContain(
			"{{name}}, {{token}} are set by a pre-request script at send."
		);
	});

	it("says nothing about a deferred name the row does not use", async () => {
		const scope = variableSupportStub({}, { deferredVariables: ["token"] });
		renderRow(scope, "row_other", "X-Host", "{{host}}");

		const text = await peekText("X-Host");
		expect(text).toContain("X-Host: resolved-host");
		expect(text).not.toContain("pre-request script");
	});

	it("says the refusal and the sentence both, each on a line of its own", async () => {
		const scope = variableSupportStub(
			{},
			{
				resolveField: (input) => ({ text: input, refusals: ["the row is refused"] }),
				deferredVariables: ["token"],
			}
		);
		renderRow(scope, "row_both", "X-Note", "{{data.v}} {{token}}");

		await peekText("X-Note");
		const lines = [...document.querySelectorAll('[role="tooltip"] .block')].map(
			(el) => el.textContent
		);
		expect(lines).toEqual([
			"the row is refused",
			"{{token}} is set by a pre-request script at send.",
		]);
	});

	it("has no marker on a row that resolves nothing and defers nothing", () => {
		const scope = variableSupportStub({}, { resolveField: leavesAsWritten });
		renderRow(scope, "row_literal", "Accept", "json");
		expect(screen.queryByRole("button", { name: PEEK })).toBeNull();

		cleanup();
		const deferring = variableSupportStub(
			{},
			{ resolveField: leavesAsWritten, deferredVariables: ["token"] }
		);
		renderRow(deferring, "row_literal_deferring", "Accept", "json");
		expect(screen.queryByRole("button", { name: PEEK })).toBeNull();
	});

	it("has no marker when the resolver changes nothing and no names are deferred", () => {
		const unchanged = variableSupportStub({}, { resolveField: leavesAsWritten });
		renderRow(unchanged, "row_none", "Authorization", "Bearer {{token}}");
		expect(screen.queryByRole("button", { name: PEEK })).toBeNull();
	});
});
