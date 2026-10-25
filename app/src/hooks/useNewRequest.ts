/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "New request" - the whole flow, once.
 *
 * It lived inside `WelcomeScreen`, which was fine while the Launcher tile was
 * the only way to ask for one. The command palette is the second, and a second
 * copy of "decide where it lands, create a collection if there is none, ask when
 * it is ambiguous" is how two entry points end up disagreeing about where a
 * request goes.
 *
 * A hook rather than a store because the flow can *ask*: the picker is a dialog,
 * and a dialog needs a component to render it. Each caller renders its own from
 * `pickerProps`, so two surfaces never fight over one dialog's open state.
 */

import { useCallback, useRef, useState } from "react";
import {
	useCollectionsQuery,
	useCreateCollectionMutation,
	useCreateRequestMutation,
} from "@/queries";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME } from "@/constants/collection";
import { resolveNewRequestTarget } from "@/modules/welcome/targetCollection";
import { EngineUnreachableError } from "@/services/http-client";
import type { Collection, CreateRequestRequest } from "@/types";

const CREATE_FAILED = "Couldn't create the request";

/**
 * The engine copy is for an engine that did not answer. Any other failure - a
 * 4xx on the payload, a bug in the caller - is not fixed by checking the engine,
 * so it says what actually went wrong.
 */
function createFailedMessage(error: unknown): string {
	if (error instanceof EngineUnreachableError) {
		return `${CREATE_FAILED}. Check that Vayu's engine is running.`;
	}
	return error instanceof Error ? `${CREATE_FAILED} - ${error.message}` : CREATE_FAILED;
}

/**
 * A request to create with fields already filled in, rather than the blank
 * `DEFAULT_REQUEST_NAME` / GET / empty-URL shape - the Launcher's demo tile
 * (issue #1694) hands over a real method and URL, and "Save to request" on an
 * agent's run (issue #1817) hands over the whole request, description included.
 * Everything but where it lands, which this flow decides.
 */
export type RequestPreset = Omit<CreateRequestRequest, "id" | "collectionId" | "name"> & {
	name?: string;
};

type PresetFieldKey = Exclude<keyof RequestPreset, "name" | "method" | "url">;

/**
 * The preset fields forwarded to the create, besides name, method and url. A
 * whitelist rather than a spread: `newRequest` is handed to `onClick` handlers,
 * and a spread forwards whatever object arrives (a React `SyntheticEvent` is
 * circular and fails the JSON encode). The `satisfies` makes a field added to
 * `CreateRequestRequest` a compile error here instead of a silent drop.
 */
const PRESET_FIELDS = {
	description: true,
	params: true,
	headers: true,
	body: true,
	bodyType: true,
	auth: true,
	elements: true,
	followRedirects: true,
	maxRedirects: true,
	timeout: true,
	httpVersion: true,
	verifySSL: true,
	stream: true,
	disableCookies: true,
	disabledSystemHeaders: true,
	disableUrlEncoding: true,
	postmanProtocolBehavior: true,
	specOperation: true,
	methodSource: true,
	order: true,
} satisfies Record<PresetFieldKey, true>;

function forwardedPresetFields(preset: RequestPreset | null): Partial<RequestPreset> {
	if (!preset) return {};
	const keys = Object.keys(PRESET_FIELDS) as PresetFieldKey[];
	return Object.fromEntries(
		keys.filter((key) => preset[key] !== undefined).map((key) => [key, preset[key]])
	);
}

/** Everything `CollectionPicker` needs, so a caller spreads it and nothing else. */
export interface NewRequestPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	collections: Collection[];
	onSelect: (collectionId: string) => void;
}

export interface NewRequestOptions {
	/**
	 * Create the request here and skip the targeting rule. For a caller that
	 * already has a stronger signal than "last worked in" - the sidebar's "+" while
	 * a collection's own tab is open. The caller vouches that it still exists.
	 */
	collectionId?: string;
}

export interface UseNewRequestReturn {
	/**
	 * Start the flow. Opens the picker only when the target is ambiguous.
	 * @param preset Fields to create the request with, instead of blank.
	 */
	newRequest: (preset?: RequestPreset, options?: NewRequestOptions) => void;
	/** A request create is in flight, so a button that starts the flow can show it. */
	isCreating: boolean;
	pickerProps: NewRequestPickerProps;
}

export function useNewRequest(): UseNewRequestReturn {
	const openTab = useTabsStore((s) => s.openTab);
	const showToast = useToastStore((s) => s.showToast);
	const lastCollectionId = useSessionStore((s) => s.lastCollectionId);
	const { data: collections = [] } = useCollectionsQuery();
	const createRequestMutation = useCreateRequestMutation();
	const createCollectionMutation = useCreateCollectionMutation();
	const [pickerOpen, setPickerOpen] = useState(false);
	/*
	 * A ref, not state: the picker can sit open for as long as the user takes to
	 * choose, and the preset that opened it must still be there when `onSelect`
	 * finally runs - a second `newRequest()` call (blank, from elsewhere) between
	 * open and pick would otherwise have nothing to overwrite it with anyway,
	 * since only one flow is ever in flight at a time.
	 */
	const presetRef = useRef<RequestPreset | null>(null);

	const createRequestIn = useCallback(
		async (collectionId: string) => {
			const preset = presetRef.current;
			try {
				const newRequest = await createRequestMutation.mutateAsync({
					...forwardedPresetFields(preset),
					collectionId,
					name: preset?.name ?? DEFAULT_REQUEST_NAME,
					method: preset?.method ?? "GET",
					url: preset?.url ?? "",
				});
				openTab({ type: "request", entityId: newRequest.id });
			} catch (error) {
				// Without this the click looks dead - the old code only logged.
				console.error("Failed to create new request:", error);
				showToast(createFailedMessage(error), "error");
			}
		},
		[createRequestMutation, openTab, showToast]
	);

	const newRequest = useCallback(
		(preset?: RequestPreset, options?: NewRequestOptions) => {
			presetRef.current = preset ?? null;
			if (options?.collectionId) {
				void createRequestIn(options.collectionId);
				return;
			}
			const target = resolveNewRequestTarget(lastCollectionId, collections);
			if (target.kind === "pick") {
				setPickerOpen(true);
				return;
			}
			if (target.kind === "collection") {
				void createRequestIn(target.collectionId);
				return;
			}
			// No collections yet - requests must belong to one, so make it first.
			void (async () => {
				try {
					const newCollection = await createCollectionMutation.mutateAsync({
						name: DEFAULT_COLLECTION_NAME,
					});
					await createRequestIn(newCollection.id);
				} catch (error) {
					console.error("Failed to create collection:", error);
					showToast(createFailedMessage(error), "error");
				}
			})();
		},
		[collections, createCollectionMutation, createRequestIn, lastCollectionId, showToast]
	);

	const onSelect = useCallback(
		(collectionId: string) => {
			setPickerOpen(false);
			void createRequestIn(collectionId);
		},
		[createRequestIn]
	);

	return {
		newRequest,
		isCreating: createRequestMutation.isPending,
		pickerProps: { open: pickerOpen, onOpenChange: setPickerOpen, collections, onSelect },
	};
}
