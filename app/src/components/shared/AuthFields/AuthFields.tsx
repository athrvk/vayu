/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthFields - the one editor for a concrete {@link EditableAuth}.
 *
 * None / Bearer / Basic / API Key were implemented twice, independently: once in
 * the request builder's `AuthPanel` and once in the collection `AuthTab`. Only
 * OAuth 2.0 was shared, through `OAuth2Form` - which was built host-agnostic
 * precisely so both sides could use it, and then applied to one mode out of
 * five. This is that pattern finished: the field groups live here, the host
 * injects the text input it wants (variable-aware in the builder, plain in the
 * collection editor), and oauth2 still goes to `OAuth2Form`.
 *
 * Because both hosts now hold the domain `RequestAuth` shape, there is nothing
 * to translate at the boundary - the component reads `mode` and `in`, the same
 * words the engine and the database use.
 *
 * Three presentation differences existed that nobody chose; each is settled here
 * once: the builder explained where credentials land and the collection editor
 * did not (it explains, on both); the collection editor highlighted `{{var}}` on
 * a plain input while the builder used the full token editor (the default input
 * keeps the highlight, the builder still injects the token editor); and "Add to"
 * was a `Select` on one side and a hand-rolled button group on the other (it is
 * the `Select` - a hand-rolled copy of a primitive never receives the
 * primitive's fixes).
 */

import { Lock } from "lucide-react";
import {
	Input,
	Label,
	SecretInput,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { OAuth2Form } from "../OAuth2Form";
import { cn } from "@/lib/utils";
import type { AuthFieldsProps, AuthTextInput } from "./types";

/**
 * Plain-input fallback for a host that injects nothing. It keeps the `{{var}}`
 * accent the collection editor had - the affordance survived the consolidation
 * even though the full token editor did not follow it here.
 */
const PlainTextInput: AuthTextInput = ({ value, onChange, placeholder, type }) =>
	type === "password" ? (
		<SecretInput value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<Input
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={cn("font-mono", value.includes("{{") && "text-variable")}
		/>
	);

/** `Authorization: Bearer <token>` and friends, in the one treatment. */
function SentAs({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-sm text-muted-foreground">
			Sent as <code className="bg-muted px-1 rounded-md font-mono text-xs">{children}</code>
		</p>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-2">
			<Label>{label}</Label>
			{children}
		</div>
	);
}

export default function AuthFields({
	value,
	onChange,
	noAuthDescription,
	TextInput = PlainTextInput,
	resolveString,
}: AuthFieldsProps) {
	if (value.mode === "none") {
		return (
			<div className="p-6 text-center bg-card border border-border rounded-md">
				<Lock className="w-5 h-5 mx-auto mb-2 text-subtle-foreground" />
				<div className="text-sm text-muted-foreground">{noAuthDescription}</div>
			</div>
		);
	}

	if (value.mode === "bearer") {
		return (
			<div className="space-y-4">
				<SentAs>Authorization: Bearer &lt;token&gt;</SentAs>
				<Field label="Token">
					<TextInput
						value={value.token}
						onChange={(token) => onChange({ ...value, token })}
						placeholder="Bearer token or {{variable}}"
					/>
				</Field>
			</div>
		);
	}

	if (value.mode === "basic") {
		return (
			<div className="space-y-4">
				<SentAs>Authorization: Basic &lt;base64&gt;</SentAs>
				<div className="grid grid-cols-2 gap-4">
					<Field label="Username">
						<TextInput
							value={value.username}
							onChange={(username) => onChange({ ...value, username })}
							placeholder="Username or {{variable}}"
						/>
					</Field>
					<Field label="Password">
						<TextInput
							value={value.password}
							onChange={(password) => onChange({ ...value, password })}
							placeholder="Password"
							type="password"
						/>
					</Field>
				</div>
			</div>
		);
	}

	if (value.mode === "apikey") {
		return (
			<div className="space-y-4">
				<p className="text-sm text-muted-foreground">
					The API key will be added as a{" "}
					{value.in === "header" ? "header" : "query parameter"}.
				</p>

				<Field label="Add to">
					<Select
						value={value.in}
						onValueChange={(next: "header" | "query") =>
							onChange({ ...value, in: next })
						}
					>
						<SelectTrigger className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="header">Header</SelectItem>
							<SelectItem value="query">Query Params</SelectItem>
						</SelectContent>
					</Select>
				</Field>

				<div className="grid grid-cols-2 gap-4">
					<Field label="Key name">
						<TextInput
							value={value.key}
							onChange={(key) => onChange({ ...value, key })}
							placeholder="X-API-Key"
						/>
					</Field>
					<Field label="Value">
						<TextInput
							value={value.value}
							onChange={(v) => onChange({ ...value, value: v })}
							placeholder="{{api_key}}"
						/>
					</Field>
				</div>
			</div>
		);
	}

	if (value.mode === "oauth2") {
		return (
			<OAuth2Form
				value={value.config}
				onChange={(config) => onChange({ ...value, config })}
				resolveString={resolveString}
				TextInput={TextInput}
			/>
		);
	}

	/*
	 * digest/aws/ntlm. The engine cannot resolve them, so there are no fields to
	 * render - but they are never collapsed to "none" either: the host names the
	 * stored mode and warns that it is still what runs, and the config rides
	 * along untouched in `value` so a save returns exactly what was loaded.
	 */
	return null;
}
