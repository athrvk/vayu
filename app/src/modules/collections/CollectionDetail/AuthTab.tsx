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
 * editable modes and nothing else. The fields are the shared `AuthFields`, the
 * same component the request builder's Auth tab renders. The bottom shows the
 * inheritance chain so the user can see which ancestor a child request would
 * resolve to.
 */

import { useEffect, useMemo, useState } from "react";
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
	EDITABLE_AUTH_MODES,
	isEditableAuthMode,
	uneditableAuthLabel,
	type EditableAuthMode,
} from "@/constants/auth-modes";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { InfoBanner, SaveFailed, SectionLabel } from "./shared";
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
const AUTH_MODE_HINTS: Record<EditableAuthMode, string> = {
	none: "Requests use no authentication unless they set their own.",
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
function asEditable(auth: CollectionAuth): EditableAuthMode | null {
	return isEditableAuthMode(auth.mode) ? auth.mode : null;
}

function defaultsFor(mode: EditableAuthMode): CollectionAuth {
	switch (mode) {
		case "none":
			return { mode: "none" };
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
}

export default function AuthTab({ collection }: AuthTabProps) {
	const updateCollection = useUpdateCollectionMutation();

	const [auth, setAuth] = useState<CollectionAuth>(collection.auth);

	// Resync the editable draft when the underlying collection changes (the
	// component is not remounted per-collection - the parent renders it inline,
	// so a different collection can arrive via props). Can't be derived: `auth`
	// is a user-editable draft that intentionally diverges from props between
	// edits and save. Render-phase reset keyed on value would miss switches to a
	// different collection whose auth happens to equal the current draft.
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setAuth(collection.auth);
	}, [collection.id, collection.auth]);

	// The other half of that resync. Shell renders <CollectionDetail /> with no
	// key, so switching collection tabs while staying on this inner tab reuses
	// this component *and its mutation* - and TanStack holds `isError` until the
	// next mutate. Without this, a save that failed on one collection would keep
	// claiming to have failed on the next one, which the user never tried to
	// save. `reset` is bound once in the observer, so it is a stable dep.
	const resetSave = updateCollection.reset;
	useEffect(() => {
		resetSave();
	}, [collection.id, resetSave]);

	const mode = asEditable(auth);
	// `mode === null` is exactly the digest/aws/ntlm set.
	const uneditableLabel = uneditableAuthLabel(auth.mode);
	const hint = mode ? AUTH_MODE_HINTS[mode] : undefined;

	const isDirty = useMemo(
		() => JSON.stringify(auth) !== JSON.stringify(collection.auth),
		[auth, collection.auth]
	);

	const handleSave = () => {
		if (!isDirty) return;
		updateCollection.mutate({ id: collection.id, auth });
	};

	const handleModeChange = (next: EditableAuthMode) => {
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
						onValueChange={(v) => handleModeChange(v as EditableAuthMode)}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue
								placeholder={
									uneditableLabel ? `${uneditableLabel} (not editable here)` : ""
								}
							/>
						</SelectTrigger>
						<SelectContent>
							{EDITABLE_AUTH_MODES.map((m) => (
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
			 * The same fields the request builder's Auth tab renders. No
			 * `TextInput` is injected: a collection has no per-request variable
			 * scope to resolve against at edit time, so the shared default -
			 * a plain input that accents `{{var}}` - is the right one here.
			 */}
			<AuthFields
				value={auth}
				onChange={setAuth}
				noAuthDescription={
					<>
						No authentication for this collection.
						<div className="text-[11px] text-muted-foreground mt-1">
							Requests using "Inherit from collection" will send no auth.
						</div>
					</>
				}
			/>

			<SaveFailed mutation={updateCollection} what="auth" className="mt-6" />

			{mode !== null && mode !== "none" && (
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
						onClick={() => setAuth(collection.auth)}
						disabled={!isDirty || updateCollection.isPending}
					>
						Reset
					</Button>
				</div>
			)}

			{mode === "none" && isDirty && (
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
