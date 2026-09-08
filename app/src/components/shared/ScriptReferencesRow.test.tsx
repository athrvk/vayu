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
 * `ScriptReferencesRow` - the "Names mentioned:" chip row ported from the
 * pre-#1512 `ScriptPanel` (request builder) and `ScriptTab` (collection),
 * both retired by #1516 with no successor (issue #1553).
 *
 * Unlike the two retired panels, this suite drives the component directly by
 * its props - no context mocking - since the whole point of the port is that
 * resolving those props is now each host's job, not this component's. The two
 * hosts' own wiring (that a `script.pre`/`script.post` element actually gets
 * this row) is covered in `ElementsPanel.test.tsx` and `ElementsTab.test.tsx`.
 *
 * `referencedVariables` itself is covered by `lib/referenced-variables.test.ts`;
 * what these assert is the painting, which a unit test of the helper cannot see.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScriptReferencesRow } from "./ScriptReferencesRow";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import type { DataContractScope, ResolvedVariable, VariableOrigin } from "@/types";

function chipFor(container: HTMLElement, name: string): HTMLElement {
	const chip = [...container.querySelectorAll<HTMLElement>('[data-slot="badge"]')].find(
		(el) => el.textContent === name
	);
	expect(chip, `no chip for ${name}`).toBeTruthy();
	return chip!;
}

const NO_ORIGINS = () => [] as VariableOrigin[];

describe("ScriptReferencesRow", () => {
	it("shows nothing for a script that mentions no variable", () => {
		const { container } = render(
			<ScriptReferencesRow
				script="console.log(1);"
				allVariables={{}}
				getVariableOrigins={NO_ORIGINS}
			/>
		);
		expect(container.textContent).toBe("");
	});

	it("drops the empty token a naive scan would chip", () => {
		const { container } = render(
			<ScriptReferencesRow
				script="const x = `{{ }}`;"
				allVariables={{}}
				getVariableOrigins={NO_ORIGINS}
			/>
		);
		expect(container.textContent).toBe("");
	});

	it("chips both syntaxes, pm references first and in the syntax each was written in", () => {
		const script = [
			'const token = pm.environment.get("auth_token");',
			'const region = pm.globals.get("region");',
			'const url = "{{base_url}}/orders?tenant={{ tenant_id }}";',
			'pm.environment.get("auth_token");', // repeat, must not duplicate
		].join("\n");

		const { container } = render(
			<ScriptReferencesRow
				script={script}
				allVariables={{
					auth_token: { value: "abc", scope: "environment" },
					region: { value: "us", scope: "global" },
				}}
				getVariableOrigins={NO_ORIGINS}
			/>
		);

		const chips = [...container.querySelectorAll('[data-slot="badge"]')].map(
			(el) => el.textContent
		);
		expect(chips).toEqual(["auth_token", "region", "{{base_url}}", "{{tenant_id}}"]);
	});

	describe("a plain pm.*.get() read", () => {
		it("is the healthy secondary chip when a variable of that name is in scope", () => {
			const { container } = render(
				<ScriptReferencesRow
					script='pm.environment.get("token");'
					allVariables={{
						token: { value: "abc", scope: "environment" } as ResolvedVariable,
					}}
					getVariableOrigins={NO_ORIGINS}
				/>
			);
			expect(chipFor(container, "token").className).toContain("bg-secondary");
		});

		it("is the destructive chip when nothing defines it", () => {
			const { container } = render(
				<ScriptReferencesRow
					script='pm.environment.get("missing_key");'
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
				/>
			);
			expect(chipFor(container, "missing_key").className).toContain("bg-destructive");
		});
	});

	describe("a plain {{name}} the script only contains", () => {
		it("is neutral, spelled as a template, and says why - never resolved/unresolved", () => {
			const { container } = render(
				<ScriptReferencesRow
					script='const u = "{{base_url}}/orders";'
					allVariables={{ base_url: { value: "https://x", scope: "global" } }}
					getVariableOrigins={NO_ORIGINS}
				/>
			);
			const chip = chipFor(container, "{{base_url}}");
			expect(chip.className).toContain("text-muted-foreground");
			expect(chip.className).not.toContain("bg-secondary");
			expect(chip.className).not.toContain("bg-destructive");
			expect(chip.getAttribute("title")).toContain("not interpolated");
		});
	});

	describe("a {{data.*}} name", () => {
		const SCRIPT = 'const to = "{{data.email}}";';

		it("is never destructive, with no contract in scope", () => {
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
				/>
			);
			const chip = chipFor(container, "data.email");
			expect(chip.className).not.toContain("bg-destructive");
			expect(chip.className).toContain("text-muted-foreground");
		});

		it("stays informational when the contract declares the column", () => {
			const contract: DataContractScope = {
				collectionId: "c1",
				collectionName: "Orders",
				columns: ["email"],
			};
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
					dataColumns={contract}
				/>
			);
			const chip = chipFor(container, "data.email");
			expect(chip.className).toContain("text-muted-foreground");
			expect(chip.getAttribute("title")).toContain("declared in Orders");
		});

		it("warns - amber, never destructive - when no contract in scope declares it", () => {
			const contract: DataContractScope = {
				collectionId: "c1",
				collectionName: "Orders",
				columns: ["name"],
			};
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
					dataColumns={contract}
				/>
			);
			const chip = chipFor(container, "data.email");
			expect(chip.className).toContain("text-warning-text");
			expect(chip.className).not.toContain("bg-destructive");
			expect(chip.getAttribute("title")).toContain("declared: name");
		});
	});

	describe("a bare column name, read through pm.variables or pm.iterationData (#1063)", () => {
		const SCRIPT = [
			'const a = pm.variables.get("email");',
			'const b = pm.iterationData.get("city");',
		].join("\n");

		it("chips a pm.variables read like the pm.iterationData read beside it - never destructive", () => {
			const contract: DataContractScope = {
				collectionId: "c1",
				collectionName: "Orders",
				columns: ["email", "city"],
			};
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
					dataColumns={contract}
				/>
			);
			const merged = chipFor(container, "email");
			const row = chipFor(container, "city");
			expect(merged.className).toBe(row.className);
			expect(merged.className).toContain("text-muted-foreground");
			expect(merged.className).not.toContain("bg-destructive");
			expect(row.getAttribute("title")).toContain("declared in Orders");
			expect(merged.getAttribute("title")).toContain("bound row's column answers this name");
		});

		it("leaves a pm.variables read painted as the variable a scope defines", () => {
			const contract: DataContractScope = {
				collectionId: "c1",
				collectionName: "Orders",
				columns: ["email", "city"],
			};
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{ email: { value: "ops@example.com", scope: "environment" } }}
					getVariableOrigins={NO_ORIGINS}
					dataColumns={contract}
				/>
			);
			expect(chipFor(container, "email").className).toContain("bg-secondary");
			expect(chipFor(container, "city").className).toContain("text-muted-foreground");
		});

		it("keeps the destructive chip for a pm.variables read that names no column", () => {
			const contract: DataContractScope = {
				collectionId: "c1",
				collectionName: "Orders",
				columns: ["city"],
			};
			const { container } = render(
				<ScriptReferencesRow
					script={SCRIPT}
					allVariables={{}}
					getVariableOrigins={NO_ORIGINS}
					dataColumns={contract}
				/>
			);
			expect(chipFor(container, "email").className).toContain("bg-destructive");
		});
	});

	describe("a single-scope pm read whose own scope answers emptily (#1196)", () => {
		const TRAP_SCRIPT = 'const d = pm.collectionVariables.get("shop_domain");';

		it("warns, names the scope that answered empty and the scope that shadows it, and never prints the value", () => {
			const { container } = render(
				<ScriptReferencesRow
					script={TRAP_SCRIPT}
					allVariables={{
						shop_domain: { value: "shop.example.com", scope: "environment" },
					}}
					getVariableOrigins={(name) =>
						name === "shop_domain"
							? [
									{
										scope: "collection",
										value: "",
										enabled: true,
										winner: false,
									},
									{
										scope: "environment",
										sourceName: "Staging",
										value: "shop.example.com",
										enabled: true,
										winner: true,
									},
								]
							: []
					}
				/>
			);

			const chip = chipFor(container, "shop_domain");
			expect(chip.className).toContain(DATA_TOKEN_TONE_CLASS.warning);
			const title = chip.getAttribute("title")!;
			expect(title).toContain("Empty at collection scope");
			expect(title).toContain("environment - Staging");
			expect(title).not.toContain("shop.example.com");
		});

		it("stays the ordinary secondary chip when the accessor's own scope actually answers", () => {
			const { container } = render(
				<ScriptReferencesRow
					script={TRAP_SCRIPT}
					allVariables={{
						shop_domain: { value: "env.example.com", scope: "environment" },
					}}
					getVariableOrigins={(name) =>
						name === "shop_domain"
							? [
									{
										scope: "collection",
										value: "collection.example.com",
										enabled: true,
										winner: false,
									},
									{
										scope: "environment",
										sourceName: "Staging",
										value: "env.example.com",
										enabled: true,
										winner: true,
									},
								]
							: []
					}
				/>
			);

			const chip = chipFor(container, "shop_domain");
			expect(chip.className).not.toContain(DATA_TOKEN_TONE_CLASS.warning);
			expect(chip.className).toContain("bg-secondary");
		});

		it("never warns for the merged pm.variables read of the same name", () => {
			const { container } = render(
				<ScriptReferencesRow
					script='const d = pm.variables.get("shop_domain");'
					allVariables={{
						shop_domain: { value: "shop.example.com", scope: "environment" },
					}}
					getVariableOrigins={(name) =>
						name === "shop_domain"
							? [
									{
										scope: "collection",
										value: "",
										enabled: true,
										winner: false,
									},
									{
										scope: "environment",
										sourceName: "Staging",
										value: "shop.example.com",
										enabled: true,
										winner: true,
									},
								]
							: []
					}
				/>
			);
			expect(chipFor(container, "shop_domain").className).not.toContain(
				DATA_TOKEN_TONE_CLASS.warning
			);
		});
	});

	it("caps chips at the configured limit and counts the rest", () => {
		const script = ["a", "b", "c", "d", "e", "f"]
			.map((name) => `pm.environment.get("${name}");`)
			.join("\n");
		const { container, getByText } = render(
			<ScriptReferencesRow
				script={script}
				allVariables={{}}
				getVariableOrigins={NO_ORIGINS}
				chipLimit={5}
			/>
		);
		expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(5);
		expect(getByText("+1 more")).toBeInTheDocument();
	});

	it("honors a wider chipLimit (the collection tab's own, pre-migration value)", () => {
		const script = ["a", "b", "c", "d", "e", "f"]
			.map((name) => `pm.environment.get("${name}");`)
			.join("\n");
		const { container } = render(
			<ScriptReferencesRow
				script={script}
				allVariables={{}}
				getVariableOrigins={NO_ORIGINS}
				chipLimit={8}
			/>
		);
		expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(6);
		expect(container.textContent).not.toContain("more");
	});
});
