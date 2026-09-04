/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeadersPanel Component
 *
 * The headers table, plus the text form of the same thing, plus a read-only
 * group naming what the engine adds on its own.
 *
 * The bulk-edit machinery - the mode flag, the draft text, the toggle handler,
 * the toolbar and the textarea - used to live here *and* in `ParamsPanel`, in
 * duplicate. It is `BulkEditor` now; only the format differs between the two,
 * and that is what this file passes.
 *
 * **The table holds only the user's headers** (issue #1229). Three rows used to
 * be seeded into it by the app itself, uneditable and saved with the request.
 * The engine adds its own at send time now and declares them over
 * `GET /request-defaults`, so they are *shown* here rather than written into
 * the request - and each can be switched off for this send.
 */

import { useCallback } from "react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { BulkEditor } from "../../../shared/BulkEditor";
import type { KeyValueItem, RequestDefaultHeader } from "@/types";
import { useHeadersManager } from "../../../hooks/useHeadersManager";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import { useRequestDefaultsQuery } from "@/queries";
import { Eyebrow } from "@/components/ui";
import { cn } from "@/lib/utils";
import { STANDARD_HEADERS } from "@/constants/http";
import { EmptyTableHint } from "./EmptyTableHint";

/**
 * One declared default, with the tick that keeps it on this send.
 *
 * Muted rather than disabled: the row is not editable - its value is the
 * engine's, and a generated one does not exist until the send makes it - but
 * the checkbox is an ordinary control, so the opt-out stays reachable by
 * keyboard and reads at full contrast.
 */
function DefaultHeaderRow({
	header,
	sent,
	onToggle,
}: {
	header: RequestDefaultHeader;
	sent: boolean;
	onToggle: (sent: boolean) => void;
}) {
	return (
		// The table's own column track, so name and value line up with the rows
		// above rather than starting a second, narrower grid.
		<div className="grid grid-cols-[24px_1fr_1fr_20px_28px] gap-2 items-center px-1 py-0.5">
			<input
				type="checkbox"
				checked={sent}
				onChange={(e) => onToggle(e.target.checked)}
				// Named after the header it governs: one per row, and a bare
				// "checkbox" says nothing about which.
				aria-label={`Send ${header.name}`}
				// `accent-primary` for the same reason the table's row checkbox
				// carries it - the browser default is a fixed blue that ignores
				// both the theme and the accent scheme.
				className="w-4 h-4 accent-primary cursor-pointer"
			/>
			<span
				className={cn(
					"text-xs font-mono text-muted-foreground truncate",
					!sent && "line-through"
				)}
				title={header.name}
			>
				{header.name}
			</span>
			{header.generated ? (
				// A generated header has no value to print - the engine makes a
				// fresh one per transfer - so the cell says that rather than
				// showing a blank the reader would take for "no value".
				<span className="text-xs italic text-subtle-foreground truncate">
					generated per request
				</span>
			) : (
				<span
					className={cn(
						"text-xs font-mono text-muted-foreground truncate",
						!sent && "line-through"
					)}
					title={header.value}
				>
					{header.value}
				</span>
			)}
			<div />
			<div />
		</div>
	);
}

export default function HeadersPanel() {
	const { request, updateField, setDisabledDefaultHeaders } = useRequestBuilderContext();
	const variables = useVariableSupport();
	const { data: requestDefaults } = useRequestDefaultsQuery();

	const { displayHeaders, handleHeadersChange, handleBulkEdit, formatForBulkEdit } =
		useHeadersManager({
			headers: request.headers,
			onUpdate: (newHeaders: KeyValueItem[]) => updateField("headers", newHeaders),
		});

	const disabled = request.disabledDefaultHeaders;
	// Its own setter, not `updateField`: an opt-out is never saved, so marking
	// the tab dirty for one would put an unsaved-changes badge - and an autosave
	// PUT - behind a tick that changes nothing stored (issue #1229).
	const toggleDefault = useCallback(
		(name: string, sent: boolean) => {
			setDisabledDefaultHeaders(
				sent ? disabled.filter((n) => n !== name) : [...disabled, name]
			);
		},
		[disabled, setDisabledDefaultHeaders]
	);

	const declared = requestDefaults?.headers ?? [];

	return (
		<BulkEditor
			label="Headers"
			format={formatForBulkEdit}
			onCommit={handleBulkEdit}
			placeholder={
				"User-Agent: MyApp/1.0\nAuthorization: Bearer token\nContent-Type: application/json"
			}
			hint={
				<>
					<code className="bg-muted px-1 rounded-md">Name: value</code>, one per line -{" "}
					<code className="bg-muted px-1 rounded-md">=</code> works too. Repeated names
					are kept as separate headers.
				</>
			}
			tableHeader={
				<EmptyTableHint items={displayHeaders} noun="headers">
					Add headers to send with this request.
				</EmptyTableHint>
			}
		>
			<div className="space-y-3">
				<KeyValueEditor
					items={displayHeaders}
					onChange={handleHeadersChange}
					keyPlaceholder="Header"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
					keySuggestions={STANDARD_HEADERS}
					variables={variables}
				/>

				{declared.length > 0 && (
					<div className="surface-sunken border border-rule rounded-md p-2 space-y-1">
						<div className="px-1">
							<Eyebrow>Added by Vayu</Eyebrow>
							<p className="text-xs text-muted-foreground mt-0.5">
								Sent by the engine unless you untick one here. A header of the same
								name in the table above wins, and none of this is saved with the
								request.
							</p>
						</div>
						{declared.map((header) => (
							<DefaultHeaderRow
								key={header.name}
								header={header}
								sent={!disabled.includes(header.name)}
								onToggle={(sent) => toggleDefault(header.name, sent)}
							/>
						))}
					</div>
				)}
			</div>
		</BulkEditor>
	);
}
