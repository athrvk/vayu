/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Import dialog's MCP server tab (#3843): where a live server is, what to send it, and which of
 * its primitives to list. Controlled: the dialog owns the state, because a tab switch must leave the
 * entered values in place and a reset must clear them, the token included. The token lives in this
 * state and nowhere else - no store, no query key, no log.
 */

import type { KeyboardEvent } from "react";
import { Button, Checkbox, Input, Label, LabelSwap, SecretInput } from "@/components/ui";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { isCommitEnter } from "@/lib/keyboard";
import { canConnectMcp, type McpFormState, type McpPrimitive } from "./import-mcp";

const PRIMITIVES: readonly { key: McpPrimitive; label: string }[] = [
	{ key: "tools", label: "Tools" },
	{ key: "resources", label: "Resources" },
	{ key: "prompts", label: "Prompts" },
];

interface ImportMcpFormProps {
	form: McpFormState;
	onChange: (form: McpFormState) => void;
	onConnect: () => void;
	/** A connect is in flight: every field is held, as the URL tab holds its box. */
	busy: boolean;
}

export function ImportMcpForm({ form, onChange, onConnect, busy }: ImportMcpFormProps) {
	const connectable = canConnectMcp(form);
	const commitOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
		if (isCommitEnter(e) && connectable && !busy) onConnect();
	};

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<Label htmlFor="import-mcp-url" className="text-xs">
					Server URL
				</Label>
				<div className="flex gap-2">
					<Input
						id="import-mcp-url"
						value={form.url}
						onChange={(e) => onChange({ ...form, url: e.target.value })}
						onKeyDown={commitOnEnter}
						placeholder="https://mcp.example.com/mcp"
						className="flex-1"
						disabled={busy}
					/>
					<Button onClick={onConnect} disabled={!connectable || busy}>
						<LabelSwap
							label={busy ? "Connecting…" : "Connect"}
							states={["Connect", "Connecting…"]}
						/>
					</Button>
				</div>
				<p className="text-label text-muted-foreground">
					Stored as written in every request, so keep a key out of the query string.
				</p>
			</div>

			<div className="space-y-1.5">
				<span className="text-xs font-medium">Headers</span>
				<KeyValueEditor
					items={form.headers}
					onChange={(headers) => onChange({ ...form, headers })}
					keyPlaceholder="Name"
					valuePlaceholder="Value"
					readOnly={busy}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="import-mcp-token" className="text-xs">
					Bearer token (optional)
				</Label>
				<SecretInput
					id="import-mcp-token"
					value={form.token}
					onChange={(token) => onChange({ ...form, token })}
					onKeyDown={commitOnEnter}
					disabled={busy}
				/>
			</div>

			<fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-muted-foreground">
				<legend className="sr-only">Import from the server</legend>
				{PRIMITIVES.map(({ key, label }) => (
					<label key={key} className="flex w-fit items-center gap-1.5">
						<Checkbox
							className="size-target"
							checked={form.include[key]}
							disabled={busy}
							onChange={(e) =>
								onChange({
									...form,
									include: { ...form.include, [key]: e.target.checked },
								})
							}
						/>
						{label}
					</label>
				))}
			</fieldset>
		</div>
	);
}
