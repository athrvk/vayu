/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthTab - collection auth source.
 *
 * Collections never use `inherit` - they ARE the source, so this tab offers the
 * editable modes plus `noauth`, the one that says "and nothing is inherited past
 * here" (see `RequestAuth`). The fields are the shared `AuthFields`, the
 * same component the request builder's Auth tab renders. The bottom shows the
 * inheritance chain so the user can see which ancestor a child request would
 * resolve to.
 *
 * **This is the one tab on the screen that still waits for a button, and that is
 * a decision (#446), not a leftover.** Info and both Script tabs commit when
 * focus leaves the field, because each is one text buffer and leaving it means
 * you are done with it. This form is not one buffer: an OAuth 2.0 config with
 * Advanced open is 20 focus stops, 9 of which are not value fields at all - the
 * grant-type and Add-to pickers, three switches, the secret's reveal toggle, the
 * Advanced disclosure, Get Token. Measured: clicking reveal to check a
 * half-typed password fires `focusout` on that field while the draft is dirty,
 * so a blur-commit would write half a credential to the record every descendant
 * request inherits from. The fields only make sense saved together, which is
 * what the button means here.
 *
 * A form that saves differently from its neighbours has to say so where the
 * typing is, not only through a button further down the page - hence the note
 * above the fields.
 */

import { useCallback } from "react";
import { Lock } from "lucide-react";

import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { AuthFields, Callout } from "@/components/shared";
import {
	AUTH_MODE_LABELS,
	COLLECTION_AUTH_MODES,
	isCollectionAuthMode,
	uneditableAuthLabel,
	type CollectionAuthMode,
} from "@/constants/auth-modes";
import { useDraftSaveContext, useEntityDraft } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { ExternalChangeCallout, InfoBanner, SaveFailed, SectionLabel } from "./shared";
import InheritanceChain from "./InheritanceChain";
import { defaultOAuth2Config } from "@/services/oauth/defaults";

type CollectionAuth = Collection["auth"];

/*
 * The one collection-specific extra, layered on the shared mode registry: an
 * inheritance-worded hint per mode. Labels and the mode list itself come from
 * `@/constants/auth-modes`, which the request `AuthPanel` reads too - they used
 * to be two arrays that had already drifted.
 *
 * OAuth 2.0 was once listed as uneditable here. It is editable now: the engine
 * resolves it, an import can produce it, requests inherit it, and `OAuth2Form`
 * was written to be shared - so the collection side was anticipated and simply
 * never wired up. digest/aws/ntlm stay uneditable: the engine has no resolution
 * for them, so offering them would let you configure something that silently
 * does nothing.
 */
const AUTH_MODE_HINTS: Record<CollectionAuthMode, string> = {
	none: 'Nothing set here: requests using "Inherit from collection" keep looking up the chain.',
	noauth: 'Requests using "Inherit from collection" send no credentials - an ancestor collection\'s auth stops here.',
	bearer: 'Token is inherited by requests that use "Inherit from collection".',
	basic: 'Credentials are inherited by requests that use "Inherit from collection".',
	apikey: 'API key is inherited by requests that use "Inherit from collection".',
	oauth2: 'Token is fetched once and inherited by requests that use "Inherit from collection".',
};

// Narrow the broader Collection auth union to the modes we expose.
// digest/aws/ntlm return null: they are stored (an import can produce
// them - see services/importers/postman.ts `collectionAuth`) but not editable
// here, and they are emphatically *not* "none". Collapsing them to "none" made
// this tab state "No authentication for this collection. Requests using
// 'Inherit from collection' will send no auth." about a collection that does
// have auth - contradicting the inheritance chain three lines below it.
function asEditable(auth: CollectionAuth): CollectionAuthMode | null {
	return isCollectionAuthMode(auth.mode) ? auth.mode : null;
}

function defaultsFor(mode: CollectionAuthMode): CollectionAuth {
	switch (mode) {
		case "none":
			return { mode: "none" };
		case "noauth":
			return { mode: "noauth" };
		case "bearer":
			return { mode: "bearer", token: "" };
		case "basic":
			return { mode: "basic", username: "", password: "" };
		case "apikey":
			return { mode: "apikey", key: "", value: "", in: "header" };
		case "oauth2":
			return { mode: "oauth2", config: defaultOAuth2Config() };
	}
}

interface AuthTabProps {
	collection: Collection;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

export default function AuthTab({ collection, active = false }: AuthTabProps) {
	const updateCollection = useUpdateCollectionMutation();

	// Draft/resync/isDirty/mutation-reset all live in the shared hook - the
	// three collection tabs used to hand-roll it one each. See useEntityDraft.
	const {
		draft: auth,
		setDraft: setAuth,
		isDirty,
		reset: resetDraft,
		externalValue,
	} = useEntityDraft<CollectionAuth>({
		entityKey: collection.id,
		value: collection.auth,
		mutation: updateCollection,
	});

	const mode = asEditable(auth);
	// `mode === null` is exactly the digest/aws/ntlm set.
	const uneditableLabel = uneditableAuthLabel(auth.mode);
	const hint = mode ? AUTH_MODE_HINTS[mode] : undefined;
	// The modes with credentials to type. `none`/`noauth` render an empty state
	// and are saved by the picker alone, so they get neither the note nor the
	// always-visible button row.
	const hasCredentialFields = mode !== null && mode !== "none" && mode !== "noauth";

	const persist = useCallback(async () => {
		if (!isDirty) return;
		await updateCollection.mutateAsync({ id: collection.id, auth });
	}, [isDirty, updateCollection, collection.id, auth]);

	useDraftSaveContext({
		id: `collection-${collection.id}-auth`,
		name: `Collection auth: ${collection.name}`,
		isDirty,
		isActive: active,
		save: persist,
	});

	// A rejection here is rendered by <SaveFailed> below; the store-driven paths
	// toast instead, since this callout may not be on screen at all.
	const handleSave = () => void persist().catch(() => {});

	const handleModeChange = (next: CollectionAuthMode) => {
		setAuth(defaultsFor(next));
	};

	return (
		<div className="max-w-[520px]">
			<InfoBanner>
				Auth set here is <strong>inherited by requests</strong> in this collection that use{" "}
				<code className="font-mono text-[11px] bg-accent px-1 rounded-sm">
					Inherit from collection
				</code>
				. Nested folders take precedence over parent folders.
			</InfoBanner>

			{externalValue !== null && (
				<ExternalChangeCallout what="auth" onTakeTheirs={resetDraft} className="mb-5" />
			)}

			{uneditableLabel && (
				<Callout
					severity="warning"
					title={`${uneditableLabel} auth is set`}
					className="mb-5"
				>
					It was imported or set elsewhere and can't be edited on this tab yet - it is
					still what descendant requests inherit. Picking a type below replaces it.
				</Callout>
			)}

			<div className="mb-5">
				<SectionLabel>Authentication type</SectionLabel>
				<div className="max-w-[280px]">
					{/*
					 * `value=""` when the stored mode isn't one of the editable ones,
					 * so the trigger shows the placeholder naming the real mode
					 * instead of falsely reading "No Auth".
					 */}
					<Select
						value={mode ?? ""}
						onValueChange={(v) => handleModeChange(v as CollectionAuthMode)}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue
								placeholder={
									uneditableLabel ? `${uneditableLabel} (not editable here)` : ""
								}
							/>
						</SelectTrigger>
						<SelectContent>
							{COLLECTION_AUTH_MODES.map((m) => (
								<SelectItem key={m} value={m}>
									{AUTH_MODE_LABELS[m]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{hint && <div className="text-[11px] text-muted-foreground mt-1.5">{hint}</div>}
			</div>

			{/*
			 * Where the typing is, not only at the button. Info and the script
			 * tabs on this same screen persist on their own, so the one form that
			 * does not has to say which kind it is before the first keystroke
			 * rather than after the user goes looking for a way to keep it.
			 */}
			{hasCredentialFields && (
				<p className="text-[11px] text-muted-foreground mb-2 flex items-center gap-1.5">
					<Lock className="w-3 h-3 shrink-0" aria-hidden="true" />
					These fields are saved together, when you press Save Auth - not as you type.
				</p>
			)}

			{/*
			 * The same fields the request builder's Auth tab renders. No
			 * `TextInput` is injected: a collection has no per-request variable
			 * scope to resolve against at edit time, so the shared default -
			 * a plain input that accents `{{var}}` - is the right one here.
			 */}
			<AuthFields
				value={auth}
				onChange={setAuth}
				noAuthDescription={
					mode === "noauth" ? (
						<>
							No authentication, and no inheriting past this collection.
							<div className="text-[11px] text-muted-foreground mt-1">
								Requests using "Inherit from collection" send no auth even if a
								parent collection defines some.
							</div>
						</>
					) : (
						<>
							No authentication set on this collection.
							<div className="text-[11px] text-muted-foreground mt-1">
								Requests using "Inherit from collection" inherit from a parent
								collection instead, if one defines auth.
							</div>
						</>
					)
				}
			/>

			<SaveFailed mutation={updateCollection} what="auth" className="mt-6" />

			{hasCredentialFields && (
				<div className="flex gap-2 mt-6">
					<Button
						onClick={handleSave}
						disabled={!isDirty || updateCollection.isPending}
						className="font-semibold"
					>
						{updateCollection.isPending ? "Saving…" : "Save Auth"}
					</Button>
					<Button
						variant="outline"
						onClick={resetDraft}
						disabled={!isDirty || updateCollection.isPending}
					>
						Reset
					</Button>
				</div>
			)}

			{(mode === "none" || mode === "noauth") && isDirty && (
				<div className="flex gap-2 mt-6">
					<Button
						onClick={handleSave}
						disabled={updateCollection.isPending}
						className="font-semibold"
					>
						{updateCollection.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			)}

			<InheritanceChain collectionId={collection.id} />
		</div>
	);
}
