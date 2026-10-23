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
 * The Code section's two promises, both of which are policy rather than markup.
 *
 * **It generates from the composed request**, not from the stored template - so
 * the snippet shows the value a `{{host}}` resolved to and the auth an
 * `inherit` walked to. Generating from the stored request instead is the
 * failure mode the whole section exists to avoid, and it would look right on
 * screen.
 *
 * **Secrets are masked until asked for.** Resolved output substitutes real
 * values into a string the user is about to paste somewhere, so the default has
 * to be hidden. Templated output cannot contain a resolved secret at all,
 * because it never resolves anything - the last case pins that, since a
 * regression there would leak the value into the mode that looks safest.
 *
 * **It composes the editor, not the saved row** (#2638). With a builder
 * holding the request, the compose body is the draft's, built the way Send
 * builds it; without one it composes by id and says the snippet is the saved
 * request's. Make the section compose by id again and the unsaved-edit case
 * fails on the URL it was handed.
 *
 * The generators themselves are covered in `services/codegen/codegen.test.ts`;
 * this file is about which input reaches them and with what options.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { CodeSection } from "./CodeSection";
import { CODE_TARGETS, SECRET_PLACEHOLDER } from "@/services/codegen";
import { useLiveCommandSurfaceStore, type EditorDraft } from "@/lib/commands/live-surfaces";
import type { RequestState } from "@/modules/request-builder/types";
import type { Collection, ResolvedVariable } from "@/types";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		composeRequest: (...args: unknown[]) => composeRequest(...args),
	},
}));

/** The stored request: a `{{host}}` and an `inherit`, neither resolved. */
const STORED = {
	id: "req_1",
	collectionId: "col_1",
	method: "POST",
	url: "https://{{host}}/v1/users",
	headers: [
		{ key: "X-Token", value: "{{token}}", enabled: true },
		{ key: "X-Off", value: "no", enabled: false },
	],
	body: { mode: "json", content: '{"a":1}' },
	auth: { mode: "inherit" },
	followRedirects: true,
};

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: STORED }),
	useCollectionAncestors: () => [],
}));

const resolved: Record<string, ResolvedVariable> = {
	host: { value: "api.example.com", scope: "global" },
	token: { value: "s3cret-token", scope: "environment", sourceId: "env_1", secret: true },
};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => resolved,
		resolveString: (s: string) => s,
		resolveObject: <T,>(o: T) => o,
	}),
}));

const showToast = vi.fn();

vi.mock("@/stores", () => ({
	useSessionStore: (selector: (s: { activeEnvironmentId: string | null }) => unknown) =>
		selector({ activeEnvironmentId: "env_1" }),
	// The copy button reaches the clipboard through `useCopy`, which reports a
	// failure as a toast - so this mock has to answer for the toast store too.
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

/** The builder's draft of `STORED`, with a URL edit autosave has not written yet. */
const DRAFT: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "Create user",
	method: "POST",
	url: "https://{{host}}/v2/users",
	params: [],
	headers: [{ id: "h1", key: "X-Token", value: "{{token}}", enabled: true }],
	disabledDefaultHeaders: [],
	bodyMode: "json",
	body: '{"a":1}',
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "inherit" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	stream: false,
};

const CHAIN = [{ id: "col_1", name: "Users", elements: [] }] as unknown as Collection[];

/** Publish a draft the way `EditorDraftSurface` does, through the slot itself. */
function publishDraft(request: RequestState) {
	const draft: EditorDraft = { request, ancestors: CHAIN };
	act(() =>
		useLiveCommandSurfaceStore
			.getState()
			.registerSurface("editorDraft", { requestId: request.id, read: () => draft })
	);
}

/** The argument of the last compose call. */
function lastComposeArg(): Record<string, unknown> {
	return composeRequest.mock.lastCall?.[0] as Record<string, unknown>;
}

const SAVED_NOTE = /From the saved request/;

function renderSection(
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<CodeSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function snippet(): string {
	return document.querySelector("pre")!.textContent ?? "";
}

/** Drive the language Select the way the repo drives every other Radix one. */
async function pickLanguage(label: string) {
	fireEvent.click(screen.getByRole("combobox", { name: "Snippet language" }));
	fireEvent.click(await screen.findByRole("option", { name: label }));
}

beforeEach(() => {
	// Radix's Select scrolls its highlighted item into view on open, and jsdom
	// has no layout, so the method does not exist - the same stub the collection
	// tree's tests use.
	Element.prototype.scrollIntoView = vi.fn();
	useLiveCommandSurfaceStore.setState({ editorDraft: null });
	composeRequest.mockReset();
	composeRequest.mockResolvedValue({
		method: "POST",
		url: "https://api.example.com/v1/users",
		headers: { "X-Token": "s3cret-token" },
		body: { mode: "json", content: '{"a":1}' },
		auth: { mode: "bearer", token: "inherited-bearer" },
	});
});

describe("CodeSection - it generates from what will be sent", () => {
	it("composes for the active environment and uses the resolved payload", async () => {
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		// No builder holds the request here, so it composes the saved row.
		expect(composeRequest).toHaveBeenCalledWith({ requestId: "req_1", environmentId: "env_1" });
		// The resolved host, not `{{host}}` - the difference between a Vayu
		// snippet and a template-based one.
		expect(snippet()).toContain("https://api.example.com/v1/users");
		expect(snippet()).not.toContain("{{host}}");
		// The inherited auth the engine walked, applied as a header: the engine
		// keeps `auth` beside the request and attaches it at send time, so a
		// snippet built from the composed headers alone would not authenticate.
		// The row is masked by its name, so the line is present with no token.
		expect(snippet()).toContain(`Authorization: ${SECRET_PLACEHOLDER}`);
		expect(snippet()).not.toContain("inherited-bearer");
	});

	it("switches language without recomposing", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));

		await pickLanguage("JS fetch");

		await waitFor(() => expect(snippet()).toContain("await fetch("));
		// One compose for every language - the payload is the same request, and
		// the generators are pure functions of it.
		expect(composeRequest).toHaveBeenCalledTimes(1);
	});

	it("offers every registered target, and generates each from the same payload", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));

		fireEvent.click(screen.getByRole("combobox", { name: "Snippet language" }));
		for (const target of CODE_TARGETS) {
			expect(screen.getByRole("option", { name: target.label })).toBeInTheDocument();
		}
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

		// A spot check per language that the resolved payload reached it - the
		// per-target grammar is `services/codegen/codegen.test.ts`.
		for (const [label, marker] of [
			["Python requests", "import requests"],
			["HTTPie", "http POST"],
			["PowerShell", "Invoke-RestMethod"],
		] as const) {
			await pickLanguage(label);
			await waitFor(() => expect(snippet()).toContain(marker));
			expect(snippet()).toContain("https://api.example.com/v1/users");
		}

		expect(composeRequest).toHaveBeenCalledTimes(1);
	});

	it("says so when composing fails instead of showing a stale snippet", async () => {
		composeRequest.mockRejectedValue(new Error("engine not running"));
		renderSection();

		expect(await screen.findByText(/Couldn't compose this request/)).toBeInTheDocument();
		expect(document.querySelector("pre")).toBeNull();
	});
});

describe("CodeSection - it composes the editor, the way Send does (#2638)", () => {
	it("composes the draft inline, unsaved edit included, rather than the row by id", async () => {
		publishDraft(DRAFT);
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		const arg = lastComposeArg();
		expect(arg).not.toHaveProperty("requestId");
		expect(arg).toMatchObject({
			request: { method: "POST", url: "https://{{host}}/v2/users" },
			collectionId: "col_1",
			environmentId: "env_1",
		});
		expect(screen.queryByText(SAVED_NOTE)).toBeNull();
	});

	it("composes the saved row by id, and says so, for another request's draft", async () => {
		publishDraft({ ...DRAFT, id: "req_2" });
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(lastComposeArg()).toEqual({ requestId: "req_1", environmentId: "env_1" });
		expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument();
	});

	it("says the snippet is the saved request's when no builder holds it", async () => {
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument();
	});

	it("recomposes on re-expand, so an edit made while collapsed is in the snippet", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		publishDraft(DRAFT);
		const first = renderSection(client);
		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		first.unmount();

		publishDraft({ ...DRAFT, url: "https://{{host}}/v3/edited" });
		renderSection(client);

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(2));
		expect(lastComposeArg()).toMatchObject({ request: { url: "https://{{host}}/v3/edited" } });
	});

	it("recomposes from the editor when a builder takes the request on after the first compose", async () => {
		renderSection();
		await waitFor(() => expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument());
		expect(lastComposeArg()).toHaveProperty("requestId", "req_1");

		publishDraft(DRAFT);

		await waitFor(() => expect(lastComposeArg()).not.toHaveProperty("requestId"));
		await waitFor(() => expect(screen.queryByText(SAVED_NOTE)).toBeNull());
		expect(composeRequest).toHaveBeenCalledTimes(2);
	});

	it("reads the stream flag from the draft it composed, not from the row", async () => {
		const stored = STORED as Record<string, unknown>;
		stored.stream = false;
		try {
			publishDraft({ ...DRAFT, stream: true });
			renderSection();

			await waitFor(() => expect(snippet()).toContain("curl"));
			expect(snippet()).toContain(" -N");
		} finally {
			delete stored.stream;
		}
	});

	it("reads the jar note from the draft it composed, not from the row", async () => {
		publishDraft({ ...DRAFT, disableCookies: true });
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(screen.getByText(/The cookie jar is off for this request/)).toBeInTheDocument();
	});

	it("labels templated output as the saved request's, since it is built from the row", async () => {
		publishDraft(DRAFT);
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(screen.queryByText(SAVED_NOTE)).toBeNull();

		fireEvent.click(screen.getByRole("radio", { name: "Templated" }));

		await waitFor(() => expect(snippet()).toContain("{{host}}"));
		expect(snippet()).toContain("/v1/users");
		expect(screen.getByText(SAVED_NOTE)).toBeInTheDocument();
	});
});

describe("CodeSection - the secret policy", () => {
	it("masks resolved secrets by default and says it did", async () => {
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		// `token` is a secret variable and the bearer credential is a secret by
		// virtue of being a credential; neither may be on screen unasked.
		expect(snippet()).not.toContain("s3cret-token");
		expect(snippet()).not.toContain("inherited-bearer");
		expect(snippet()).toContain("<secret>");
		expect(screen.getByText(/Secrets are hidden/)).toBeInTheDocument();
	});

	it("reveals them only on an explicit act", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("<secret>"));

		fireEvent.click(screen.getByRole("button", { name: "Reveal secrets" }));

		await waitFor(() => expect(snippet()).toContain("s3cret-token"));
		expect(snippet()).toContain("inherited-bearer");
		expect(screen.queryByText(/Secrets are hidden/)).not.toBeInTheDocument();
	});

	it("never puts a resolved secret in templated output", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));

		fireEvent.click(screen.getByRole("radio", { name: "Templated" }));

		await waitFor(() => expect(snippet()).toContain("{{host}}"));
		// The template is the request as written: the token reference, never the
		// value behind it, whichever way the reveal toggle was left.
		expect(snippet()).toContain("{{token}}");
		expect(snippet()).not.toContain("s3cret-token");
		expect(snippet()).not.toContain("inherited-bearer");
		// Disabled header rows are not sent, so they are not in the snippet.
		expect(snippet()).not.toContain("X-Off");
		// Nothing to hide, so no reveal control to offer.
		expect(screen.queryByRole("button", { name: /secrets/i })).not.toBeInTheDocument();
	});
});

describe("CodeSection - redirect policy reaches both funnels", () => {
	// `stream` has its own overlay comment above because `POST /compose`
	// deliberately omits it; `followRedirects` has no such overlay; it is
	// carried straight through the composed payload in resolved mode. Templated
	// mode builds its own `SnippetRequest` in `templatedRequest` (issue #1445:
	// it read every field but this one, so a stored request that followed
	// redirects generated a curl command that did not).
	it("templated mode's -L matches the stored request's setting, same as resolved mode's", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(snippet()).toContain(" -L");

		fireEvent.click(screen.getByRole("radio", { name: "Templated" }));
		await waitFor(() => expect(snippet()).toContain("{{host}}"));
		expect(snippet()).toContain(" -L");
	});
});

describe("CodeSection - the fidelity it cannot promise", () => {
	it("states that jar cookies are not in the snippet", async () => {
		renderSection();
		await waitFor(() => expect(snippet()).toContain("curl"));
		// libcurl attaches them at transfer time, so they are not in the composed
		// payload and cannot be in a static command.
		expect(screen.getByText(/Cookies from the jar/)).toBeInTheDocument();
	});

	it("says the jar is off instead, for a request that skips it (#1765)", async () => {
		// The snippet is then the whole request, so the jar line would be a
		// caveat about cookies the send never attaches.
		const stored = STORED as Record<string, unknown>;
		stored.disableCookies = true;
		try {
			renderSection();
			await waitFor(() => expect(snippet()).toContain("curl"));
			expect(screen.getByText(/The cookie jar is off for this request/)).toBeInTheDocument();
			expect(screen.queryByText(/Cookies from the jar/)).toBeNull();
		} finally {
			delete stored.disableCookies;
		}
	});
});

describe("CodeSection - names a token a pre-request script will set (#2521)", () => {
	/** A scripted request composes with its templates intact. */
	function composeDeferred(names?: string[]) {
		composeRequest.mockResolvedValue({
			method: "POST",
			url: "https://{{host}}/v1/users",
			headers: [{ name: "X-Token", value: "{{token}}" }],
			...(names ? { deferredVariables: names } : {}),
		});
	}

	it("lists the deferred names beside the snippet, in the resolved mode", async () => {
		composeDeferred(["host", "token"]);
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		// The braces are in the command because the script runs first; the note
		// is what says so.
		expect(snippet()).toContain("{{host}}");
		expect(
			screen.getByText("{{host}}, {{token}} are set by a pre-request script at send.")
		).toBeInTheDocument();
	});

	it("speaks of one name in the singular", async () => {
		composeDeferred(["token"]);
		renderSection();

		expect(
			await screen.findByText("{{token}} is set by a pre-request script at send.")
		).toBeInTheDocument();
	});

	it.each([
		["omitted", undefined],
		["empty", []],
	])("says nothing when the list is %s", async (_, names) => {
		composeDeferred(names);
		renderSection();

		await waitFor(() => expect(snippet()).toContain("curl"));
		expect(screen.queryByText(/pre-request script/)).toBeNull();
	});

	it("says nothing in the templated mode, which composes nothing", async () => {
		composeDeferred(["token"]);
		renderSection();
		await screen.findByText(/set by a pre-request script/);

		fireEvent.click(screen.getByRole("radio", { name: "Templated" }));

		await waitFor(() => expect(snippet()).toContain("{{host}}"));
		expect(screen.queryByText(/pre-request script/)).toBeNull();
	});
});
