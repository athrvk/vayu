/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthTab - collection auth source.
 *
 * Collections never use `inherit` - they ARE the source. Only None / Bearer /
 * Basic / API Key are exposed here. The bottom shows the inheritance chain so
 * the user can see which ancestor a child request would resolve to.
 */

import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import {
	Button,
	Input,
	SecretInput,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { cn } from "@/lib/utils";
import { useUpdateCollectionMutation } from "@/queries/collections";
import type { Collection } from "@/types";
import { InfoBanner, SaveFailed, SectionLabel } from "./shared";
import InheritanceChain from "./InheritanceChain";
import OAuth2Form from "@/components/shared/OAuth2Form/OAuth2Form";
import { defaultOAuth2Config } from "@/services/oauth/defaults";

type CollectionAuthMode = "none" | "bearer" | "basic" | "apikey" | "oauth2";
type CollectionAuth = Collection["auth"];

/**
 * Display names for the modes this tab stores but cannot edit.
 *
 * OAuth 2.0 used to be here. It is editable now: the engine resolves it, an
 * import can produce it, requests inherit it, and `OAuth2Form` was written to be
 * shared - its own contract mentions "the collection editor supplies a plain
 * Input" - so the collection side was anticipated and simply never wired up.
 *
 * digest/aws/ntlm stay: the engine has no resolution for them, so offering them
 * here would let you configure something that silently does nothing.
 */
const UNEDITABLE_LABELS: Record<string, string> = {
	digest: "Digest",
	aws: "AWS Signature",
	ntlm: "NTLM",
};

const AUTH_OPTIONS: { value: CollectionAuthMode; label: string; hint: string }[] = [
	{
		value: "none",
		label: "No Auth",
		hint: "Requests use no authentication unless they set their own.",
	},
	{
		value: "bearer",
		label: "Bearer Token",
		hint: 'Token is inherited by requests that use "Inherit from collection".',
	},
	{
		value: "basic",
		label: "Basic Auth",
		hint: 'Credentials are inherited by requests that use "Inherit from collection".',
	},
	{
		value: "apikey",
		label: "API Key",
		hint: 'API key is inherited by requests that use "Inherit from collection".',
	},
	{
		value: "oauth2",
		label: "OAuth 2.0",
		hint: 'Token is fetched once and inherited by requests that use "Inherit from collection".',
	},
];

// Narrow the broader Collection auth union to the modes we expose.
// digest/aws/ntlm return null: they are stored (an import can produce
// them - see services/importers/postman.ts `collectionAuth`) but not editable
// here, and they are emphatically *not* "none". Collapsing them to "none" made
// this tab state "No authentication for this collection. Requests using
// 'Inherit from collection' will send no auth." about a collection that does
// have auth - contradicting the inheritance chain three lines below it.
function asEditable(auth: CollectionAuth): CollectionAuthMode | null {
	if (
		auth.mode === "none" ||
		auth.mode === "bearer" ||
		auth.mode === "basic" ||
		auth.mode === "apikey" ||
		auth.mode === "oauth2"
	) {
		return auth.mode;
	}
	return null;
}

function defaultsFor(mode: CollectionAuthMode): CollectionAuth {
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
	const uneditableLabel = mode === null ? (UNEDITABLE_LABELS[auth.mode] ?? auth.mode) : null;
	const hint = useMemo(() => AUTH_OPTIONS.find((o) => o.value === mode)?.hint, [mode]);

	const isDirty = useMemo(
		() => JSON.stringify(auth) !== JSON.stringify(collection.auth),
		[auth, collection.auth]
	);

	const handleSave = () => {
		if (!isDirty) return;
		updateCollection.mutate({ id: collection.id, auth });
	};

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
					 * `value=""` when the stored mode isn't one of the four below, so
					 * the trigger shows the placeholder naming the real mode instead
					 * of falsely reading "No Auth".
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
							{AUTH_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{hint && <div className="text-[11px] text-muted-foreground mt-1.5">{hint}</div>}
			</div>

			<AuthConfig auth={auth} onChange={setAuth} />

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

interface AuthConfigProps {
	auth: CollectionAuth;
	onChange: (next: CollectionAuth) => void;
}

function AuthConfig({ auth, onChange }: AuthConfigProps) {
	if (auth.mode === "none") {
		return (
			<div className="p-6 text-center bg-card border border-border rounded-md">
				<Lock className="w-3.5 h-3.5 mx-auto text-subtle-foreground mb-2" />
				<div className="text-[13px] text-muted-foreground">
					No authentication for this collection.
				</div>
				<div className="text-[11px] text-muted-foreground mt-1">
					Requests using "Inherit from collection" will send no auth.
				</div>
			</div>
		);
	}

	if (auth.mode === "bearer") {
		return (
			<div>
				<SectionLabel>Token</SectionLabel>
				<Input
					value={auth.token}
					onChange={(e) => onChange({ ...auth, token: e.target.value })}
					placeholder="Bearer token or {{variable}}"
					className={cn("font-mono", auth.token.includes("{{") && "text-variable")}
				/>
				<div className="text-[11px] text-muted-foreground mt-1.5">
					Sent as{" "}
					<code className="font-mono text-[10px] bg-accent px-1 rounded-sm">
						Authorization: Bearer &lt;token&gt;
					</code>
				</div>
			</div>
		);
	}

	if (auth.mode === "basic") {
		return (
			<div className="grid grid-cols-2 gap-3">
				<div>
					<SectionLabel>Username</SectionLabel>
					<Input
						value={auth.username}
						onChange={(e) => onChange({ ...auth, username: e.target.value })}
						placeholder="{{username}}"
						className={cn("font-mono", auth.username.includes("{{") && "text-variable")}
					/>
				</div>
				<div>
					<SectionLabel>Password</SectionLabel>
					<SecretInput
						value={auth.password}
						onChange={(password) => onChange({ ...auth, password })}
						placeholder="{{password}}"
					/>
				</div>
			</div>
		);
	}

	if (auth.mode === "apikey") {
		return (
			<div className="flex flex-col gap-3.5">
				<div className="grid grid-cols-2 gap-3">
					<div>
						<SectionLabel>Key name</SectionLabel>
						<Input
							value={auth.key}
							onChange={(e) => onChange({ ...auth, key: e.target.value })}
							placeholder="X-API-Key"
							className="font-mono"
						/>
					</div>
					<div>
						<SectionLabel>Value</SectionLabel>
						<Input
							value={auth.value}
							onChange={(e) => onChange({ ...auth, value: e.target.value })}
							placeholder="{{apiKey}}"
							className={cn(
								"font-mono",
								auth.value.includes("{{") && "text-variable"
							)}
						/>
					</div>
				</div>
				<div>
					<SectionLabel>Add to</SectionLabel>
					<div className="flex gap-2">
						{(["header", "query"] as const).map((loc) => {
							const active = auth.in === loc;
							return (
								<button
									key={loc}
									type="button"
									onClick={() => onChange({ ...auth, in: loc })}
									className={cn(
										"px-3.5 py-1.5 rounded-md text-xs font-medium border transition-colors",
										active
											? "bg-primary/10 border-primary text-primary"
											: "bg-card border-border text-foreground hover:border-primary/40"
									)}
								>
									{loc === "header" ? "Header" : "Query param"}
								</button>
							);
						})}
					</div>
				</div>
			</div>
		);
	}

	if (auth.mode === "oauth2") {
		/*
		 * The same form the request builder uses. `OAuth2Form` takes an injected
		 * `TextInput` precisely so the two hosts can differ - the request side
		 * passes a variable-aware input, and this one takes the default plain
		 * input, because a collection has no per-request variable scope to
		 * resolve against at edit time.
		 */
		return (
			<OAuth2Form value={auth.config} onChange={(config) => onChange({ ...auth, config })} />
		);
	}

	return null;
}
