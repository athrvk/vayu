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
 * A variable name the engine would refuse or a map would fold must never cost
 * the user a variable (#3251).
 *
 * The payload is a map keyed by name, built from rows keyed by what the user
 * typed. Folding by name made a rename onto an existing name delete the renamed
 * variable, and a cleared name was skipped and then read as a deletion of the
 * key it used to hold. A row that cannot be written under its name is now held
 * back, marked, and kept (with the editor dirty) until the user fixes it or
 * deletes it; a name is trimmed when the field is left, not while it is typed.
 *
 * The harness is `VariableTableEditor.status-stomp.test.tsx`'s: the real save
 * store, and a save that lands only when the test says so.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act, within } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import {
	expectShowsError,
	expectShowsNoError,
} from "@/components/shared/ElementList/field-error.testkit";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, VariableValue } from "@/types";

interface MutateOptions {
	onSuccess: () => void;
	onError: (error: Error) => void;
}

interface UpdatePayload {
	variables: Record<string, VariableValue>;
}

/** The save in flight - landed by hand, so the test owns when it arrives. */
let pendingSave: { opts: MutateOptions };
const updateCollection = vi.fn((_payload: UpdatePayload, opts: MutateOptions) => {
	pendingSave = { opts };
});

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({
		mutate: vi.fn(),
		// Answers through the per-call callbacks, as a mounted mutation does.
		mutateAsync: (...args: unknown[]) => {
			updateCollection(...(args as Parameters<typeof updateCollection>));
			return new Promise(() => {});
		},
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function variable(value: string, createdAt: number): VariableValue {
	return { value, enabled: true, secret: false, type: "string", createdAt };
}

function collectionOf(variables: Record<string, VariableValue>): Collection {
	return {
		id: "col_1",
		name: "demo",
		description: "",
		order: 0,
		variables,
		auth: { mode: "none" },
		elements: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

const stored = (): Record<string, VariableValue> => ({
	token: variable("abc", 1000),
	host: variable("example.com", 2000),
});

function mount(collection = collectionOf(stored())) {
	const ui = (c: Collection) => (
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection: c }} />
		</TooltipProvider>
	);
	const view = render(ui(collection));
	return { ...view, rerenderWith: (c: Collection) => view.rerender(ui(c)) };
}

/** The name fields in table order: `token`, `host`, then the trailing blank row. */
const nameFields = () => screen.getAllByLabelText("Variable name") as HTMLInputElement[];

const payloads = () => updateCollection.mock.calls.map(([payload]) => payload.variables);

/** The variables the latest save sent. */
const lastPayload = (): Record<string, VariableValue> => payloads()[payloads().length - 1] ?? {};

const editorContext = () => useSaveStore.getState().contexts.get("collection-col_1");

/** Type into a field and leave it, which is what starts a save. */
function typeAndLeave(field: HTMLElement, value: string) {
	fireEvent.change(field, { target: { value } });
	fireEvent.blur(field);
}

function landSave() {
	act(() => pendingSave.opts.onSuccess());
}

describe("a variable name the editor cannot write", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	it("keeps both variables when one is renamed onto the other, and marks the renamed row", () => {
		mount();

		typeAndLeave(nameFields()[0], "host");
		landSave();

		expect(updateCollection).toHaveBeenCalled();
		for (const variables of payloads()) {
			expect(variables.token?.value).toBe("abc");
			expect(variables.host?.value).toBe("example.com");
		}
		expect(screen.getByDisplayValue("abc")).toBeInTheDocument();
		expect(screen.getByDisplayValue("example.com")).toBeInTheDocument();
		expectShowsError(nameFields()[0], "Name already used");
		expectShowsNoError(nameFields()[1]);
	});

	it("keeps the editor dirty so the held row survives the save's cache echo", () => {
		const { rerenderWith } = mount();

		typeAndLeave(nameFields()[0], "host");
		landSave();

		expect(editorContext()?.hasPendingChanges).toBe(true);
		expect(useSaveStore.getState().status).toBe("pending");

		rerenderWith(collectionOf(stored()));
		expect(nameFields()[0].value).toBe("host");
		expectShowsError(nameFields()[0], "Name already used");
	});

	it("saves the rename once the new name is free, and drops the old key", () => {
		mount();

		typeAndLeave(nameFields()[0], "host");
		typeAndLeave(nameFields()[0], "access_token");
		// Saves run one at a time: the first landing starts the second.
		landSave();
		landSave();

		const sent = lastPayload();
		expect(sent.access_token?.value).toBe("abc");
		expect(sent.token).toBeUndefined();
		expect(sent.host?.value).toBe("example.com");
		expectShowsNoError(nameFields()[0]);
		expect(editorContext()?.hasPendingChanges).toBe(false);
	});

	it("flags a new row that reuses a stored name rather than overwriting it", () => {
		mount();

		typeAndLeave(nameFields()[2], "host");
		landSave();

		for (const variables of payloads()) {
			expect(variables.host?.value).toBe("example.com");
		}
		expectShowsError(nameFields()[2], "Name already used");
		expectShowsNoError(nameFields()[1]);
	});

	it("holds a cleared name instead of deleting the variable it belonged to", () => {
		const { rerenderWith } = mount();

		typeAndLeave(nameFields()[0], "");
		landSave();

		for (const variables of payloads()) {
			expect(variables.token?.value).toBe("abc");
			expect(variables.host?.value).toBe("example.com");
		}
		expect(screen.getByDisplayValue("abc")).toBeInTheDocument();
		expectShowsError(nameFields()[0], "Needs a name");
		expect(editorContext()?.hasPendingChanges).toBe(true);

		// The cache echo of that save must not reseed the row away.
		rerenderWith(collectionOf(stored()));
		expect(nameFields()[0].value).toBe("");
		expectShowsError(nameFields()[0], "Needs a name");
	});

	it("remembers the name a saved rename stored, so clearing it later deletes nothing", () => {
		const { rerenderWith } = mount();
		const echoLastSave = () => rerenderWith(collectionOf(lastPayload()));
		// A held row keeps the editor dirty, so no reseed re-derives the stored names.
		const values = screen.getAllByLabelText("Variable value") as HTMLInputElement[];
		typeAndLeave(values[0], "orphan");
		landSave();
		echoLastSave();

		typeAndLeave(nameFields()[0], "access_token");
		landSave();
		echoLastSave();
		typeAndLeave(nameFields()[0], "");
		landSave();

		const sent = lastPayload();
		expect(sent.access_token?.value).toBe("abc");
		expect(sent.host?.value).toBe("example.com");
	});

	it("treats a whitespace-only name as empty", () => {
		mount();

		typeAndLeave(nameFields()[0], "   ");
		landSave();

		for (const variables of payloads()) {
			expect(variables.token?.value).toBe("abc");
			expect(Object.keys(variables).sort()).toEqual(["host", "token"]);
		}
		expectShowsError(nameFields()[0], "Needs a name");
	});

	it("does not promote the blank row for a whitespace-only name", () => {
		mount();
		expect(nameFields()).toHaveLength(3);

		fireEvent.change(nameFields()[2], { target: { value: "  " } });

		expect(nameFields()).toHaveLength(3);
		expectShowsNoError(nameFields()[2]);
	});

	it("flags a value typed into the blank row before it has a name, and keeps it", () => {
		mount();

		const values = screen.getAllByLabelText("Variable value") as HTMLInputElement[];
		typeAndLeave(values[0], "orphan");
		landSave();

		expect(nameFields()).toHaveLength(4);
		expectShowsError(nameFields()[2], "Needs a name");
		expect(screen.getByDisplayValue("orphan")).toBeInTheDocument();
		for (const variables of payloads()) {
			expect(Object.keys(variables).sort()).toEqual(["host", "token"]);
		}
		expect(editorContext()?.hasPendingChanges).toBe(true);
	});

	it("counts only the variables that are stored under a name", () => {
		mount();
		expect(screen.queryByText("2 variables")).not.toBeNull();

		typeAndLeave(nameFields()[0], "host");

		expect(screen.queryByText("1 variable")).not.toBeNull();
	});

	it("offers no agent reference for a row whose name is held back", () => {
		mount();
		const rowOf = (field: HTMLElement) => within(field.closest("tr") as HTMLElement);

		expect(rowOf(nameFields()[0]).queryByLabelText("Copy token for agent")).not.toBeNull();

		typeAndLeave(nameFields()[0], "host");

		expect(rowOf(nameFields()[0]).queryByLabelText(/^Copy .* for agent$/)).toBeNull();
	});
});

describe("a variable name's padding", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	it("survives while the name is typed and is cut when the field is left", () => {
		mount();

		fireEvent.change(nameFields()[2], { target: { value: "key " } });
		expect(nameFields()[2].value).toBe("key ");

		fireEvent.blur(nameFields()[2]);
		landSave();

		expect(nameFields()[2].value).toBe("key");
		expect(lastPayload()).toHaveProperty("key");
		expect(lastPayload()).not.toHaveProperty(["key "]);
	});

	it("is cut from a stored name that is edited to carry it", () => {
		mount();

		typeAndLeave(nameFields()[0], " token2  ");
		landSave();

		const sent = lastPayload();
		expect(sent.token2?.value).toBe("abc");
		expect(Object.keys(sent).sort()).toEqual(["host", "token2"]);
		expectShowsNoError(nameFields()[0]);
	});

	it("is compared trimmed, so a padded copy of a stored name is a duplicate", () => {
		mount();

		typeAndLeave(nameFields()[2], " host ");
		landSave();

		expect(lastPayload().host?.value).toBe("example.com");
		expectShowsError(nameFields()[2], "Name already used");
	});
});

describe("the explicit Delete", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	it("still removes a stored variable", () => {
		mount();

		fireEvent.click(screen.getByLabelText("Delete token"));

		expect(updateCollection).toHaveBeenCalledTimes(1);
		const sent = payloads()[0];
		expect(sent.token).toBeUndefined();
		expect(sent.host?.value).toBe("example.com");
	});

	it("removes a variable whose name was cleared, and only that one", () => {
		mount();

		typeAndLeave(nameFields()[0], "");
		landSave();
		fireEvent.click(screen.getByLabelText("Delete variable"));
		landSave();

		const sent = lastPayload();
		expect(sent.token).toBeUndefined();
		expect(sent.host?.value).toBe("example.com");
		expect(editorContext()?.hasPendingChanges).toBe(false);
	});

	it("removes a row that was held for a duplicate name, and the other keeps its own", () => {
		mount();

		typeAndLeave(nameFields()[0], "host");
		landSave();
		fireEvent.click(screen.getAllByLabelText("Delete host")[0]);

		const sent = lastPayload();
		expect(sent.token).toBeUndefined();
		expect(sent.host?.value).toBe("example.com");
	});
});

describe("a legacy stored name the engine would refuse", () => {
	// Written before the engine began refusing a blank or padded name: `foo ` can
	// never be referenced, and sending it back is a 400 for every save.
	const legacy = (): Record<string, VariableValue> => ({
		foo: variable("kept", 1000),
		other: variable("o", 2000),
		"foo ": variable("padded", 3000),
		"": variable("blank", 4000),
	});
	const isAddressable = (name: string) => name !== "" && name === name.trim();

	beforeEach(() => {
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	it("is left out of an unrelated save, which deletes nothing addressable", () => {
		mount(collectionOf(legacy()));

		typeAndLeave(screen.getByDisplayValue("kept"), "edited");
		landSave();

		const sent = lastPayload();
		expect(Object.keys(sent).every(isAddressable)).toBe(true);
		expect(Object.keys(sent).sort()).toEqual(["foo", "other"]);
		expect(sent.foo.value).toBe("edited");
		expect(sent.other.value).toBe("o");
	});

	it("stays on screen, flagged and unsaved, so it can still be named", () => {
		const { rerenderWith } = mount(collectionOf(legacy()));

		typeAndLeave(screen.getByDisplayValue("kept"), "edited");
		landSave();
		rerenderWith(collectionOf(lastPayload()));

		expect(screen.getByDisplayValue("padded")).toBeInTheDocument();
		expect(screen.getByDisplayValue("blank")).toBeInTheDocument();
		expectShowsError(nameFields()[2], "Name already used");
		expectShowsError(nameFields()[3], "Needs a name");
		expect(editorContext()?.hasPendingChanges).toBe(true);

		typeAndLeave(nameFields()[3], "fresh");
		landSave();

		expect(lastPayload().fresh?.value).toBe("blank");
		expect(Object.keys(lastPayload()).every(isAddressable)).toBe(true);
	});
});
