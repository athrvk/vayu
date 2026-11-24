/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The headers table, its text form, and a read-only group naming what the engine adds itself. Bulk
 * edit is `BulkEditor`; only the format differs from `ParamsPanel`. **The table holds only the
 * user's headers** (#1229): the engine adds its own at send time and declares them over
 * `GET /request-defaults`, so they are *shown* here, not written into the request, and each can be
 * switched off for this send.
 */

import { useCallback } from "react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { KEY_VALUE_GRID } from "@/components/shared/KeyValueEditor/grid";
import { BulkEditor } from "../../../shared/BulkEditor";
import type { KeyValueItem, RequestDefaultHeader } from "@/types";
import { useHeadersManager } from "../../../hooks/useHeadersManager";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import { useRequestDefaultsQuery } from "@/queries";
import { Checkbox, Eyebrow } from "@/components/ui";
import { cn } from "@/lib/utils";
import { STANDARD_HEADERS } from "@/constants/http";
import { EmptyTableHint } from "./EmptyTableHint";
import { isStoredOff } from "../../../utils/automatic-headers";

/**
 * One declared default, with the tick keeping it on this send. Muted, not disabled: the value is
 * the engine's (a generated one exists only at send), but the checkbox is ordinary, so the opt-out
 * stays keyboard-reachable at full contrast.
 */
function DefaultHeaderRow({
	header,
	sent,
	storedOff,
	onToggle,
}: {
	header: RequestDefaultHeader;
	sent: boolean;
	/**
	 * Off on every send by the request's stored `disabledSystemHeaders` (#1765). The engine unions
	 * that with this send's opt-outs, so a tick could not restore it: the box shows off, disabled,
	 * and the value cell names the tab owning the setting.
	 */
	storedOff: boolean;
	onToggle: (sent: boolean) => void;
}) {
	return (
		// The table's column track, so name and value line up with the rows above.
		<div className={cn("grid gap-2 items-center px-1 py-0.5", KEY_VALUE_GRID)}>
			<Checkbox
				checked={sent && !storedOff}
				disabled={storedOff}
				onChange={(e) => onToggle(e.target.checked)}
				// Named after its header: one per row, and a bare "checkbox" says nothing.
				aria-label={`Send ${header.name}`}
				// `size-target` (#1679), not `size-icon`: a bare checkbox is its own hit target, as
				// `KeyValueRow`'s row-enable checkbox is.
				className="size-target"
			/>
			<span
				className={cn(
					"text-xs font-mono text-muted-foreground truncate",
					(!sent || storedOff) && "line-through"
				)}
				title={header.name}
			>
				{header.name}
			</span>
			{storedOff ? (
				// Wraps rather than truncates: the tab it names is the point.
				<span className="text-xs italic text-muted-foreground">
					off for this request in Settings
				</span>
			) : header.generated ? (
				// A generated header has no value to print (a fresh one per transfer), so the cell
				// says so rather than show a blank read as "no value".
				<span className="text-xs italic text-muted-foreground truncate">
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
	const {
		request,
		updateField,
		setDisabledDefaultHeaders,
		bulkDrafts,
		setBulkDraft,
		commitBulkDraft,
	} = useRequestBuilderContext();
	const variables = useVariableSupport();
	const { data: requestDefaults } = useRequestDefaultsQuery();

	// Stable, not an inline arrow: `useHeadersManager` returns it as `handleHeadersChange`, the
	// `KeyValueEditor` `onChange` every row callback depends on, so a fresh identity would
	// re-render every row per keystroke (#1716).
	const onHeadersUpdate = useCallback(
		(newHeaders: KeyValueItem[]) => updateField("headers", newHeaders),
		[updateField]
	);
	const { displayHeaders, handleHeadersChange, formatForBulkEdit } = useHeadersManager({
		headers: request.headers,
		onUpdate: onHeadersUpdate,
	});

	const disabled = request.disabledDefaultHeaders;
	// Its own setter, not `updateField`: an opt-out is never saved, so marking the tab dirty would
	// put an unsaved badge, and an autosave PUT, behind a tick that changes nothing stored (#1229).
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
			draft={bulkDrafts.headers ?? null}
			onDraftChange={(next) => setBulkDraft("headers", next)}
			onCommit={() => commitBulkDraft("headers")}
			placeholder={
				"User-Agent: MyApp/1.0\nAuthorization: Bearer token\nContent-Type: application/json"
			}
			hint={
				<>
					<code className="bg-muted px-1 rounded-md">Name: value</code>, one per line -{" "}
					<code className="bg-muted px-1 rounded-md">=</code> works too. Repeated names
					are kept as separate headers. A leading{" "}
					<code className="bg-muted px-1 rounded-md">// </code> disables the row;
					everything after the separator's first space is sent exactly as typed.
				</>
			}
			tableHeader={
				<EmptyTableHint items={displayHeaders} noun="headers">
					Add headers to send with this request.
				</EmptyTableHint>
			}
			after={
				declared.length > 0 && (
					<div className="enter-fade surface-sunken border border-rule rounded-md p-2 space-y-1">
						<div className="px-1">
							<Eyebrow>Added by Vayu</Eyebrow>
							<p className="text-xs text-muted-foreground mt-0.5">
								Sent by Vayu unless you untick one here. A header of the same name
								in the table above wins. An untick here is for this send only and is
								not saved; to leave one off every send, use the Settings tab.
							</p>
						</div>
						{declared.map((header) => (
							<DefaultHeaderRow
								key={header.name}
								header={header}
								sent={!disabled.includes(header.name)}
								storedOff={isStoredOff(request.disabledSystemHeaders, header.name)}
								onToggle={(sent) => toggleDefault(header.name, sent)}
							/>
						))}
					</div>
				)
			}
		>
			<KeyValueEditor
				items={displayHeaders}
				onChange={handleHeadersChange}
				keyPlaceholder="Header"
				valuePlaceholder="Value"
				showResolved={true}
				allowDisable={true}
				keySuggestions={STANDARD_HEADERS}
				variables={variables}
				fieldContext="header"
			/>
		</BulkEditor>
	);
}
