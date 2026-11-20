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
 * The `jwt_bearer` grant's fields (#3632): which of the form's fields it shows,
 * and the one rule the key control enforces - exactly one of a `{{variable}}`
 * and a picked file, and never a PEM typed into a field.
 */

import { useMemo, useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { variableSupportStub } from "@/test/variable-support";
import type { OAuth2Config, ResolvedVariable, VariableSupport } from "@/types";
import VariableInput from "@/components/shared/VariableInput";
import OAuth2Form from "./OAuth2Form";
import type { OAuth2TextInput } from "./types";

const statusRow = vi.fn();
vi.mock("./TokenStatusRow", () => ({
	default: (props: unknown) => {
		statusRow(props);
		return null;
	},
}));

const JWT: OAuth2Config = {
	grantType: "jwt_bearer",
	accessTokenUrl: "https://idp.test/token",
	clientId: "svc",
};

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";

/** The form over state, so a value the form refuses is visibly still the old one. */
function renderForm(
	initial: OAuth2Config,
	variables?: VariableSupport,
	resolveString?: (text: string) => string
) {
	const latest: { value: OAuth2Config } = { value: initial };
	// Every config the form asked its host to keep, which is what autosaves.
	const emitted: OAuth2Config[] = [];
	function Harness() {
		const [value, setValue] = useState(initial);
		latest.value = value;
		return (
			<TooltipProvider>
				<OAuth2Form
					value={value}
					onChange={(next) => {
						emitted.push(next);
						setValue(next);
					}}
					variables={variables}
					resolveString={resolveString}
					collectionId="col-1"
				/>
			</TooltipProvider>
		);
	}
	const view = render(<Harness />);
	return { ...view, latest, emitted };
}

const keyField = () => screen.getByLabelText("Private key");

function pickFile(container: HTMLElement, file: File) {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("no file input rendered");
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	fireEvent.change(input);
}

afterEach(() => {
	vi.unstubAllGlobals();
	statusRow.mockReset();
});

describe("the jwt_bearer grant's fields", () => {
	it("shows the assertion's fields and no client secret", () => {
		renderForm(JWT);

		for (const label of [
			"Client ID",
			"Subject",
			"Assertion audience",
			"Private key",
			"Signing algorithm",
			"Key ID",
			"Assertion lifetime (seconds)",
			"Scope",
		]) {
			expect(screen.getByLabelText(label), label).toBeInTheDocument();
		}
		expect(screen.queryByLabelText("Client secret")).toBeNull();
		expect(screen.queryByLabelText("Username")).toBeNull();
		expect(screen.queryByLabelText("Authorization URL")).toBeNull();
	});

	it("shows none of them for another grant", () => {
		renderForm({ ...JWT, grantType: "client_credentials" });

		for (const label of ["Subject", "Assertion audience", "Private key", "Key ID"]) {
			expect(screen.queryByLabelText(label), label).toBeNull();
		}
		expect(screen.getByLabelText("Client secret")).toBeInTheDocument();
	});

	it("offers the claims table with no per-row Send in select", () => {
		renderForm({ ...JWT, assertionClaims: [{ key: "tenant", value: "acme", enabled: true }] });

		const claims = screen.getByRole("group", { name: "Extra claims" });
		expect(within(claims).getByDisplayValue("tenant")).toBeInTheDocument();
		expect(within(claims).queryByRole("combobox")).toBeNull();
	});

	it("keeps the claims table's rows out of the token request parameters", () => {
		const { latest } = renderForm(JWT);

		const claims = screen.getByRole("group", { name: "Extra claims" });
		fireEvent.change(within(claims).getAllByPlaceholderText("Parameter")[0], {
			target: { value: "tenant" },
		});

		expect(latest.value.assertionClaims).toEqual([{ key: "tenant", value: "", enabled: true }]);
		expect(latest.value.tokenParams).toBeUndefined();
	});

	it("drops a stored client secret when the grant is chosen, since no field would show it", () => {
		const { latest } = renderForm({
			...JWT,
			grantType: "client_credentials",
			clientSecret: "hunter2",
		});

		fireEvent.click(screen.getByRole("combobox", { name: "Grant type" }));
		fireEvent.click(screen.getByRole("option", { name: "JWT bearer" }));

		expect(latest.value.grantType).toBe("jwt_bearer");
		expect("clientSecret" in latest.value).toBe(false);
	});

	it("leaves the signing algorithm to the engine's default until one is chosen", () => {
		const { latest } = renderForm(JWT);

		expect(screen.getByRole("combobox", { name: "Signing algorithm" })).toHaveTextContent(
			"RS256"
		);
		expect(latest.value.signingAlgorithm).toBeUndefined();

		fireEvent.click(screen.getByRole("combobox", { name: "Signing algorithm" }));
		fireEvent.click(screen.getByRole("option", { name: "ES256" }));

		expect(latest.value.signingAlgorithm).toBe("ES256");
	});

	it("writes the lifetime as a number and removes it when emptied", () => {
		const { latest } = renderForm(JWT);
		const lifetime = screen.getByLabelText("Assertion lifetime (seconds)");
		expect(lifetime).toHaveAttribute("placeholder", "180");

		fireEvent.change(lifetime, { target: { value: "300" } });
		expect(latest.value.assertionLifetimeSeconds).toBe(300);

		fireEvent.change(lifetime, { target: { value: "" } });
		expect("assertionLifetimeSeconds" in latest.value).toBe(false);
	});
});

describe("the config the token row sends", () => {
	const resolve = (text: string) =>
		text.replace(VARIABLE_PATTERN, (_m, name: string) => `<${name}>`);

	it("resolves what the token request carries and leaves the key as the reference", () => {
		renderForm(
			{
				...JWT,
				subject: "{{who}}",
				assertionAudience: "{{aud}}",
				keyId: "{{kid}}",
				assertionClaims: [{ key: "tenant", value: "{{tenant}}", enabled: true }],
				privateKey: "{{signing_key}}",
			},
			undefined,
			resolve
		);

		const sent = (statusRow.mock.lastCall?.[0] as { resolvedConfig: OAuth2Config })
			.resolvedConfig;
		expect(sent).toMatchObject({
			subject: "<who>",
			assertionAudience: "<aud>",
			keyId: "<kid>",
			assertionClaims: [{ key: "tenant", value: "<tenant>" }],
		});
		expect(sent.privateKey).toBe("{{signing_key}}");
	});

	it("hands the row the collection to name to the engine", () => {
		renderForm(JWT);

		expect((statusRow.mock.lastCall?.[0] as { collectionId: string }).collectionId).toBe(
			"col-1"
		);
	});
});

describe("the signing key control", () => {
	it("stores a variable reference", () => {
		const { latest } = renderForm(JWT);

		fireEvent.change(keyField(), { target: { value: "{{signing_key}}" } });

		expect(latest.value.privateKey).toBe("{{signing_key}}");
	});

	it("refuses a typed PEM with a sentence naming a secret variable or a file, and stores nothing", () => {
		const { latest } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		fireEvent.change(keyField(), { target: { value: PEM } });

		expect(screen.getByRole("alert")).toHaveTextContent(/secret variable.*key file/);
		expect(latest.value.privateKey).toBe("{{signing_key}}");
		expect(keyField()).toHaveValue("{{signing_key}}");
		expect(JSON.stringify(latest.value)).not.toContain("BEGIN");
	});

	it("refuses a PEM whatever surrounds the marker", () => {
		const { latest } = renderForm(JWT);

		fireEvent.change(keyField(), { target: { value: `  {{x}} ${PEM}` } });

		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(latest.value.privateKey).toBeUndefined();
	});

	it("clears the refusal once a reference is typed", () => {
		renderForm(JWT);
		fireEvent.change(keyField(), { target: { value: PEM } });

		fireEvent.change(keyField(), { target: { value: "{{signing_key}}" } });

		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("emits nothing while a reference is half typed and commits it once, when it completes", () => {
		const { latest, emitted } = renderForm(JWT);

		for (const typed of ["{", "{{", "{{sig", "{{signing_key}", "{{signing_key}}"]) {
			fireEvent.change(keyField(), { target: { value: typed } });
		}

		const written = emitted.map((config) => config.privateKey);
		expect(written).toEqual(["{{signing_key}}"]);
		expect(latest.value.privateKey).toBe("{{signing_key}}");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("never hands half-typed text to the config and says what to enter instead", () => {
		const { emitted } = renderForm(JWT);

		fireEvent.change(keyField(), { target: { value: "-----BEGI" } });
		fireEvent.change(keyField(), { target: { value: "{{sig" } });

		expect(emitted).toEqual([]);
		expect(keyField()).toHaveValue("{{sig");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Enter the secret variable as {{name}}"
		);
	});

	it("does not commit a reference with no name in it", () => {
		const { emitted } = renderForm(JWT);

		fireEvent.change(keyField(), { target: { value: "{{ }}" } });

		expect(emitted).toEqual([]);
	});

	it("drops an unfinished draft on blur and shows what is stored again", () => {
		const { emitted } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		fireEvent.change(keyField(), { target: { value: "{{signing_key}}x" } });
		expect(keyField()).toHaveValue("{{signing_key}}x");
		fireEvent.blur(keyField());

		expect(emitted).toEqual([]);
		expect(keyField()).toHaveValue("{{signing_key}}");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("commits an emptied field as the member removed, once", () => {
		const { latest, emitted } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		fireEvent.change(keyField(), { target: { value: "" } });

		expect(emitted).toHaveLength(1);
		expect("privateKey" in latest.value).toBe(false);
	});

	it("commits nothing for a refused PEM and keeps what was stored", () => {
		const { emitted } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		fireEvent.change(keyField(), { target: { value: PEM } });

		expect(emitted).toEqual([]);
	});

	it("removes the member when the field is emptied", () => {
		const { latest } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		fireEvent.change(keyField(), { target: { value: "" } });

		expect("privateKey" in latest.value).toBe(false);
	});

	it("records a picked file by its path and clears the reference", () => {
		const getFilePath = vi.fn(() => "/home/me/keys/signing.pem");
		vi.stubGlobal("electronAPI", { getFilePath });
		const { container, latest } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });
		const file = new File(["x"], "signing.pem");

		pickFile(container, file);

		// The path comes from the preload, whose lookup is also what records the
		// engine's grant for the pick (`file-pick.ts`).
		expect(getFilePath).toHaveBeenCalledWith(file);
		expect(latest.value.privateKeyFile).toBe("/home/me/keys/signing.pem");
		expect("privateKey" in latest.value).toBe(false);
		expect(keyField()).toHaveValue("/home/me/keys/signing.pem");
		expect(keyField()).toHaveAttribute("readonly");
	});

	it("claims no file when the pick has no path, as outside Electron", () => {
		vi.stubGlobal("electronAPI", undefined);
		const { container, latest } = renderForm({ ...JWT, privateKey: "{{signing_key}}" });

		pickFile(container, new File(["x"], "signing.pem"));

		expect(screen.getByRole("alert")).toHaveTextContent(/path/);
		expect(latest.value.privateKeyFile).toBeUndefined();
		expect(latest.value.privateKey).toBe("{{signing_key}}");
	});

	it("clears the file and offers the variable field again when the file is removed", () => {
		const { latest } = renderForm({ ...JWT, privateKeyFile: "/home/me/keys/signing.pem" });

		fireEvent.click(screen.getByRole("button", { name: "Remove key file" }));

		expect("privateKeyFile" in latest.value).toBe(false);
		expect(keyField()).not.toHaveAttribute("readonly");
	});

	it("clears a stored file when a reference is typed beside it", () => {
		// A config that arrives holding both (an import, a hand edit) is mended by
		// the first choice the user makes, never left holding two sources.
		const { latest } = renderForm({
			...JWT,
			privateKey: "{{a}}",
			privateKeyFile: "/home/me/keys/signing.pem",
		});
		expect(keyField()).toHaveValue("/home/me/keys/signing.pem");

		fireEvent.click(screen.getByRole("button", { name: "Remove key file" }));
		fireEvent.change(keyField(), { target: { value: "{{b}}" } });

		expect(latest.value.privateKey).toBe("{{b}}");
		expect(latest.value.privateKeyFile).toBeUndefined();
	});
});

describe("the secret variable hint", () => {
	const variables = (secret: boolean | undefined) =>
		variableSupportStub({
			signing_key: { value: "v", scope: "environment", secret },
		});

	it("warns when the variable it names is not marked secret", () => {
		renderForm({ ...JWT, privateKey: "{{signing_key}}" }, variables(false));

		expect(screen.getByText(/signing_key is not marked secret/)).toBeInTheDocument();
	});

	it("keeps the plain hint for a secret variable", () => {
		renderForm({ ...JWT, privateKey: "{{signing_key}}" }, variables(true));

		expect(screen.queryByText(/not marked secret/)).toBeNull();
	});

	it("says nothing about a variable it cannot find, which the engine names itself", () => {
		renderForm({ ...JWT, privateKey: "{{other}}" }, variables(false));

		expect(screen.queryByText(/not marked secret/)).toBeNull();
	});
});

/*
 * The hint's "mark it secret" has a first step: the name is undefined, so the
 * token's popover offers to create it. That create used to be plain, which left
 * the hint to tell the user to go and mark it in the Variables editor.
 */
describe("creating the key's variable from its popover", () => {
	/** A scope whose `updateVariable` records what a create carried, as the writer would store it. */
	function StatefulForm() {
		const [defined, setDefined] = useState<Record<string, ResolvedVariable>>({});
		const variables = useMemo(
			() =>
				variableSupportStub(defined, {
					writableScopes: ["environment"],
					updateVariable: (name, value, scope, _sourceId, options) =>
						setDefined((all) => ({
							...all,
							[name]: { value, scope, ...(options?.secret && { secret: true }) },
						})),
				}),
			[defined]
		);
		// The host's own field (`AuthPanel`'s): the one that paints the token.
		const TextInput: OAuth2TextInput = ({ id, label, value, onChange, placeholder }) => (
			<VariableInput
				id={id}
				aria-label={label}
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				variables={variables}
			/>
		);
		return (
			<TooltipProvider>
				<OAuth2Form
					value={{ ...JWT, privateKey: "{{signing_key}}" }}
					onChange={() => {}}
					variables={variables}
					TextInput={TextInput}
					collectionId="col-1"
				/>
			</TooltipProvider>
		);
	}

	function createFromPopover({ secret }: { secret: boolean }) {
		render(<StatefulForm />);
		fireEvent.keyDown(screen.getByRole("button", { name: "{{signing_key}}" }), {
			key: "Enter",
		});
		const popover = within(screen.getByRole("dialog"));
		if (secret) {
			fireEvent.click(
				popover.getByRole("button", { name: "Mark as secret (masks value in UI)" })
			);
		}
		fireEvent.change(popover.getByLabelText(/value for new variable/i), {
			target: { value: "pem" },
		});
		fireEvent.click(popover.getByRole("button", { name: "Create" }));
	}

	it("stops the hint warning when the new variable was created secret", () => {
		createFromPopover({ secret: true });

		expect(screen.queryByText(/not marked secret/)).toBeNull();
	});

	it("still warns when the new variable was created plain", () => {
		createFromPopover({ secret: false });

		expect(screen.getByText(/signing_key is not marked secret/)).toBeInTheDocument();
	});
});

describe("the fallback token lifetime", () => {
	it.each(["client_credentials", "password", "authorization_code", "jwt_bearer"] as const)(
		"is offered under Advanced for %s",
		(grantType) => {
			const { latest } = renderForm({ ...JWT, grantType });
			fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

			fireEvent.change(screen.getByLabelText("Token lifetime if none is stated (seconds)"), {
				target: { value: "900" },
			});

			expect(latest.value.fallbackExpiresIn).toBe(900);
		}
	);

	it("states the longest lifetime the engine keeps, as the field's own maximum", () => {
		renderForm(JWT);
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

		expect(screen.getByLabelText("Token lifetime if none is stated (seconds)")).toHaveAttribute(
			"max",
			"31536000"
		);
	});
});
