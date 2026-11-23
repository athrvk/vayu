/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Discovery from an MCP server URL, for the authorization code grant (#3766).
 *
 * The switch turns `discoverUrl` on; the sign-in then fills what the config
 * leaves blank (see `services/oauth/discovery.ts`). What it filled is named in
 * `discoveredFields` and shown read-only by the form, so a diff of the stored
 * request says what was found. Discover again clears those members, so the next
 * sign-in finds the server's current endpoints and registers a fresh client:
 * the way back from a registered client the server no longer accepts, such as
 * one registered for an earlier loopback port. Turning the switch off keeps
 * what was found, as ordinary editable values.
 */

import { RefreshCw } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { DISCOVER_URL_LABEL, DISCOVERED_FIELD_LABELS } from "@/constants/oauth2-fields";
import { clearDiscovered } from "@/services/oauth/discovery";
import type { OAuth2Config } from "@/types";
import { LabelledField } from "../LabelledField";
import { fieldListPhrase } from "./missing-fields";
import type { OAuth2TextInput } from "./types";

interface DiscoveryFieldsProps {
	value: OAuth2Config;
	onChange: (next: OAuth2Config) => void;
	TextInput: OAuth2TextInput;
}

export default function DiscoveryFields({ value, onChange, TextInput }: DiscoveryFieldsProps) {
	const on = value.discoverUrl !== undefined;
	const found = value.discoveredFields ?? [];

	const setOn = (next: boolean) => {
		if (next) return onChange({ ...value, discoverUrl: "" });
		const { discoverUrl: _url, discoveredFields: _found, ...rest } = value;
		onChange(rest);
	};

	return (
		<div className="space-y-4">
			<label className="flex items-center gap-2 text-xs text-muted-foreground">
				<Switch checked={on} onCheckedChange={setOn} />
				Discover from the server URL
			</label>

			{on && (
				<LabelledField
					label={DISCOVER_URL_LABEL}
					hint="Sign-in reads the server's OAuth metadata and fills the fields left blank. With no client ID it registers a client."
					className="space-y-1.5"
				>
					{(c) => (
						<TextInput
							{...c}
							value={value.discoverUrl ?? ""}
							onChange={(v) => onChange({ ...value, discoverUrl: v })}
							placeholder="https://mcp.example.com/mcp"
						/>
					)}
				</LabelledField>
			)}

			{on && found.length > 0 && (
				<div className="flex items-center gap-3">
					<p className="flex-1 min-w-0 text-label text-muted-foreground">
						Found by discovery:{" "}
						{fieldListPhrase(found.map((field) => DISCOVERED_FIELD_LABELS[field]))}
					</p>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => onChange(clearDiscovered(value))}
					>
						<RefreshCw className="size-icon-sm" />
						Discover again
					</Button>
				</div>
			)}
		</div>
	);
}
