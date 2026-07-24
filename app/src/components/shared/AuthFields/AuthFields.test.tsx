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
 * The shared auth field editor (issue #105).
 *
 * Bearer / Basic / API Key / None existed twice - once in the request builder's
 * `AuthPanel`, once in the collection `AuthTab` - and had already drifted in
 * three visible ways. These tests pin the consolidated behaviour: the domain
 * vocabulary on the wire out (`mode`, `in` - never `api-key` / `addTo`), the
 * injected text input, and the `{{var}}` accent the collection editor
 * contributed surviving in the default input.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { EditableAuth, AuthTextInput } from "./types";
import AuthFields from "./AuthFields";

function renderFields(value: EditableAuth, TextInput?: AuthTextInput) {
	const onChange = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const result = render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<AuthFields
					value={value}
					onChange={onChange}
					noAuthDescription="Nothing will be sent."
					TextInput={TextInput}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { ...result, onChange };
}

describe("AuthFields edits in the domain vocabulary", () => {
	it("writes apikey's location as `in`, not `addTo`", () => {
		// The builder's flat editor state called this `addTo`, and a mapper
		// renamed it on every boundary crossing. Both sides say `in` now; a
		// reintroduced rename fails here.
		const { onChange } = renderFields({
			mode: "apikey",
			key: "X-API-Key",
			value: "v",
			in: "header",
		});

		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /Query Params/i }));

		expect(onChange).toHaveBeenCalledWith({
			mode: "apikey",
			key: "X-API-Key",
			value: "v",
			in: "query",
		});
	});

	it("keeps the rest of the object when one field changes", () => {
		const { onChange } = renderFields({ mode: "basic", username: "u", password: "p" });

		fireEvent.change(screen.getByPlaceholderText(/Username/i), {
			target: { value: "root" },
		});

		expect(onChange).toHaveBeenCalledWith({
			mode: "basic",
			username: "root",
			password: "p",
		});
	});

	it("renders nothing for a mode the engine cannot resolve", () => {
		// digest/aws/ntlm have no fields, but they are never collapsed to "none"
		// either - the host names the stored mode, and the config rides along in
		// `value` untouched so a save returns exactly what was loaded.
		const { container } = renderFields({ mode: "digest", config: { username: "u" } });
		expect(container).toBeEmptyDOMElement();
	});
});

describe("AuthFields host parameterisation", () => {
	it("routes every text field through the injected input", () => {
		const Injected: AuthTextInput = ({ value, onChange, placeholder }) => (
			<input
				data-testid="injected"
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
			/>
		);
		renderFields({ mode: "apikey", key: "k", value: "v", in: "header" }, Injected);

		// Key name and Value - the two text fields of the api-key group.
		expect(screen.getAllByTestId("injected")).toHaveLength(2);
	});

	it("accents {{variables}} in the default input, which the collection editor relies on", () => {
		// The collection tab used a plain Input with a `text-variable` class; the
		// builder used the full token editor. The default input keeps the accent
		// so the collection side lost nothing in the consolidation.
		renderFields({ mode: "bearer", token: "{{token}}" });
		expect(screen.getByPlaceholderText(/Bearer token or/i).className).toContain(
			"text-variable"
		);
	});

	it("does not accent a literal value", () => {
		renderFields({ mode: "bearer", token: "abc" });
		expect(screen.getByPlaceholderText(/Bearer token or/i).className).not.toContain(
			"text-variable"
		);
	});

	it("says where the credentials land, on both hosts", () => {
		// The builder explained this; the collection editor did not. One
		// presentation now, so the explanation reaches both.
		renderFields({ mode: "basic", username: "", password: "" });
		expect(screen.getByText(/Authorization: Basic/i)).toBeInTheDocument();
	});

	it("uses the host's own words for No Auth", () => {
		// A request sends nothing; a collection hands nothing down. Different
		// statements, one empty state.
		renderFields({ mode: "none" });
		expect(screen.getByText("Nothing will be sent.")).toBeInTheDocument();
	});
});
