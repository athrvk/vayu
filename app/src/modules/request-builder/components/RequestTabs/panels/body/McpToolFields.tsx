/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an `mcp` body adds to the raw JSON pane (#3762): the tool a `tools/call`
 * names, and a note on the headers the engine writes.
 *
 * **The headers are the engine's, and this panel displays none of its own
 * derivation.** `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and
 * `Mcp-Param-*` are derived at send time from the bytes about to leave, in the
 * one builder every client shares, and reported on the response as the request
 * headers that were sent. A list computed here would be a second reader of the
 * body that drifts from it. The note says where to look instead.
 *
 * The tool exists for `Mcp-Param-*`: the engine mirrors each argument its
 * `inputSchema` marks `x-mcp-header`. Without a stored tool none is sent, which
 * the note says in that state because nothing else on screen would. The fields
 * are typed by hand; the import path is expected to fill them (#3762).
 */

import { useState } from "react";
import { CodeEditor, Input } from "@/components/ui";
import { Callout } from "@/components/shared/Callout";
import { FieldError } from "@/components/shared/FieldError";
import { LabelledField } from "@/components/shared/LabelledField";
import type { McpTool } from "@/types";
import { requestModelPath } from "../../../../utils/editor-models";
import { describes, fieldsOf, readFields, type McpToolFields as Fields } from "./mcp-tool";

export interface McpToolFieldsProps {
	/** The tool the request stores, or undefined when it stores none. */
	tool: McpTool | undefined;
	onToolChange: (tool: McpTool | undefined) => void;
	requestId: string | null;
}

const NAME_ERROR_ID = "mcp-tool-name-error";
const SCHEMA_ERROR_ID = "mcp-tool-schema-error";

export default function McpToolFields({ tool, onToolChange, requestId }: McpToolFieldsProps) {
	const [fields, setFields] = useState<Fields>(() => fieldsOf(tool));

	/*
	 * A request switch or an external write moved the stored tool away from what
	 * the fields commit: take it. Typing never trips this, and a field the engine
	 * would refuse commits nothing, so it is held rather than overwritten.
	 */
	if (!describes(fields, tool)) setFields(fieldsOf(tool));

	const { nameError, schemaError } = readFields(fields);

	const edit = (next: Fields) => {
		setFields(next);
		const { tool: committed } = readFields(next);
		// Only a change the engine would accept is stored; the fields keep the rest.
		if (!describes(next, tool)) onToolChange(committed);
	};

	return (
		<div className="flex flex-col gap-3">
			<Callout severity="info" title="MCP headers">
				Vayu&apos;s engine adds Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name and any
				Mcp-Param-* header when it sends, so none is typed here. They appear under the
				response&apos;s request headers.
				{!tool && " With no tool set, no Mcp-Param-* header is sent."}
			</Callout>

			<div className="grid gap-3 md:grid-cols-[minmax(12rem,16rem)_1fr]">
				<LabelledField
					label="MCP tool"
					hint="The tool a tools/call body names. Set it to mirror x-mcp-header arguments."
				>
					{({ id }) => (
						<>
							<Input
								id={id}
								size="sm"
								value={fields.name}
								onChange={(e) => edit({ ...fields, name: e.target.value })}
								placeholder="execute_sql"
								aria-invalid={nameError ? true : undefined}
								aria-describedby={nameError ? NAME_ERROR_ID : undefined}
							/>
							<FieldError id={NAME_ERROR_ID}>{nameError}</FieldError>
						</>
					)}
				</LabelledField>

				<div className="space-y-2">
					<p className="text-sm font-medium leading-none">Input schema</p>
					<div className="h-28 overflow-hidden rounded-md border border-input">
						<CodeEditor
							height="100%"
							language="json"
							ariaLabel="MCP tool input schema"
							path={requestModelPath(requestId, "mcp-input-schema")}
							value={fields.schema}
							onChange={(v) => edit({ ...fields, schema: v ?? "" })}
						/>
					</div>
					<FieldError id={SCHEMA_ERROR_ID}>{schemaError}</FieldError>
				</div>
			</div>
		</div>
	);
}
