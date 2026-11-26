/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collection auth source. A collection never uses `inherit` (it *is* the source), so this tab
 * offers the editable modes plus `noauth`, which says "and nothing is inherited past here" (see
 * `RequestAuth`). The fields are the shared `AuthFields`, as on the request builder's Auth tab; the
 * inheritance chain below shows which ancestor a child request would resolve to.
 *
 * **It waits for a button, by decision (#446).** The Info tab commits each field when focus leaves
 * it, as each is one text buffer. This form is not one buffer: an OAuth 2.0 config with Advanced
 * open is 20 focus stops, 9 of them not value fields (the grant-type and Add-to pickers, three
 * switches, the secret's reveal toggle, the Advanced disclosure, Get Token). Measured: clicking
 * reveal to check a half-typed password fires `focusout` on that field while the draft is dirty, so
 * a blur-commit would write half a credential to the record every descendant request inherits from.
 * The fields only make sense saved together, which is what the button means; the Elements tab waits
 * for its button on the same basis.
 *
 * A form that saves unlike its neighbours has to say so where the typing is, not only through a
 * button further down the page, hence the note above the fields.
 */

import { useCallback } from "react";
import { Lock } from "lucide-react";

import {
	Button,
	LabelSwap,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { AuthFields, Callout, ExternalChangeCallout } from "@/components/shared";
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
import { InfoBanner, SaveFailed, SectionLabel } from "./shared";
import InheritanceChain from "./InheritanceChain";
import { persistedDraft, useStoredCollectionDraft } from "./collection-drafts";
import { defaultOAuth2Config } from "@/services/oauth/defaults";

type CollectionAuth = Collection["auth"];

/*
 * The one collection-specific extra on the shared mode registry: an inheritance-worded hint per
 * mode. Labels and the mode list come from `@/constants/auth-modes`, which the request `AuthPanel`
 * reads too, so the two lists cannot drift. OAuth 2.0 is editable (the engine resolves it, an
 * import can produce it, requests inherit it, and `OAuth2Form` is shared); digest/aws/ntlm are not:
 * the engine has no resolution for them, so offering them would configure something that silently
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

// Narrow the Collection auth union to the modes exposed here. digest/aws/ntlm return null: they are
// stored (an import can produce them, see services/importers/postman.ts `collectionAuth`) but not
// editable, and emphatically *not* "none", which would have this tab say requests inheriting from
// it send no auth, contradicting the inheritance chain below.
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

	// Draft, resync, isDirty and mutation reset live in the shared hook (see useEntityDraft). The
	// key is also how the context bar's `CollectionAuthSection` reads the draft
	// (`useCollectionAuthDraft`), so it shows the picked-but-unsaved mode, not the stored one
	// (#1483).
	const stored = useStoredCollectionDraft(collection.id, "auth");
	const {
		draft: auth,
		setDraft: setAuth,
		isDirty,
		reset: resetDraft,
		consumeDiscard,
		markSaved,
		externalValue,
	} = useEntityDraft<CollectionAuth>({
		entityKey: stored.key,
		value: persistedDraft(collection, "auth"),
		mutation: updateCollection,
	});

	const mode = asEditable(auth);
	// `mode === null` is exactly the digest/aws/ntlm set.
	const uneditableLabel = uneditableAuthLabel(auth.mode);
	const hint = mode ? AUTH_MODE_HINTS[mode] : undefined;
	// The modes with fields to type into gate the "saved together" hint. `none`/`noauth` render an
	// empty state with nothing to type but share the Save Auth button: every mode on this tab
	// commits on that click, never on the picker alone.
	const hasCredentialFields = mode !== null && mode !== "none" && mode !== "noauth";

	const persist = useCallback(async () => {
		if (!isDirty) return;
		await updateCollection.mutateAsync({ id: collection.id, auth });
		markSaved(auth);
	}, [isDirty, updateCollection, collection.id, auth, markSaved]);

	useDraftSaveContext({
		id: `collection-${collection.id}-auth`,
		name: `Collection auth: ${collection.name}`,
		isDirty,
		isActive: active,
		save: persist,
		consumeDiscard,
		stored,
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
				<code className="font-mono text-label bg-accent px-1 rounded-sm">
					Inherit from collection
				</code>
				. Nested collections take precedence over parent collections.
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
					It was imported or set elsewhere and can't be edited on this tab yet. Vayu does
					not send this auth type, so requests that inherit it go out without auth.
					Picking a type below replaces it.
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
						<SelectTrigger
							className="h-control text-sm"
							aria-label="Authentication type"
						>
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
				{hint && <div className="text-label text-muted-foreground mt-1.5">{hint}</div>}
			</div>

			{/*
			 * Where the typing is, not only at the button: the Info tab on this screen persists on
			 * its own, so this form says it does not before the first keystroke, rather than after
			 * the user goes looking for a way to keep it.
			 */}
			{hasCredentialFields && (
				<p className="text-label text-muted-foreground mb-2 flex items-center gap-1.5">
					<Lock className="size-icon-sm shrink-0" aria-hidden="true" />
					These fields are saved together, when you press Save auth - not as you type.
				</p>
			)}

			{/*
			 * The request builder's Auth fields. No `TextInput` is injected: a collection has no
			 * per-request variable scope to resolve against at edit time, so the shared default (a
			 * plain input accenting `{{var}}`) is the right one here.
			 */}
			<AuthFields
				value={auth}
				onChange={setAuth}
				collectionId={collection.id}
				noAuthDescription={
					mode === "noauth" ? (
						<>
							No authentication, and no inheriting past this collection.
							<div className="text-label text-muted-foreground mt-1">
								Requests using "Inherit from collection" send no auth even if a
								parent collection defines some.
							</div>
						</>
					) : (
						<>
							No authentication set on this collection.
							<div className="text-label text-muted-foreground mt-1">
								Requests using "Inherit from collection" inherit from a parent
								collection instead, if one defines auth.
							</div>
						</>
					)
				}
			/>

			<SaveFailed mutation={updateCollection} what="auth" className="mt-6" />

			<div className="flex gap-2 mt-6">
				<Button
					onClick={handleSave}
					disabled={!isDirty || updateCollection.isPending}
					className="font-semibold"
				>
					<LabelSwap
						label={updateCollection.isPending ? "Saving…" : "Save auth"}
						states={["Save auth", "Saving…"]}
					/>
				</Button>
				<Button
					variant="outline"
					onClick={resetDraft}
					disabled={!isDirty || updateCollection.isPending}
				>
					Reset
				</Button>
			</div>

			<InheritanceChain collectionId={collection.id} draftAuth={auth} />
		</div>
	);
}
