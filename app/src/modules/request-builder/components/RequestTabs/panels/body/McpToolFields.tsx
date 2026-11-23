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
 * are typed by hand; importing an MCP server is what will fill them (#3765).
 *
 * The output schema is the one input the engine never reads: the builder does,
 * to prefill an `assert.jsonschema` element for this tool's `structuredContent`
 * (#3806). It lives beside the input schema because both are what `tools/list`
 * states about the tool, and an edit of either must not drop the other.
 *
 * The schema editor is not a native control, so `LabelledField`'s
 * `<label for>` cannot name it; the label and the error reach it through a
 * named group instead, the shape `GenericElementForm`'s map field uses.
 */

import { useState } from "react";
import { CodeEditor, Input } from "@/components/ui";
import { Callout } from "@/components/shared/Callout";
import { FieldError } from "@/components/shared/FieldError";
import { LabelledField } from "@/components/shared/LabelledField";
import type { McpTool } from "@/types";
import { requestModelPath, type EditorPane } from "../../../../utils/editor-models";
import { describes, fieldsOf, readFields, type McpToolFields as Fields } from "./mcp-tool";

export interface McpToolFieldsProps {
	/** The tool the request stores, or undefined when it stores none. */
	tool: McpTool | undefined;
	onToolChange: (tool: McpTool | undefined) => void;
	requestId: string | null;
}

const NAME_ERROR_ID = "mcp-tool-name-error";
const SCHEMA_LABEL_ID = "mcp-tool-schema-label";
const SCHEMA_ERROR_ID = "mcp-tool-schema-error";
const OUTPUT_LABEL_ID = "mcp-tool-output-schema-label";
const OUTPUT_ERROR_ID = "mcp-tool-output-schema-error";

export default function McpToolFields({ tool, onToolChange, requestId }: McpToolFieldsProps) {
	const [fields, setFields] = useState<Fields>(() => fieldsOf(tool));

	/*
	 * A request switch or an external write moved the stored tool away from what
	 * the fields commit: take it. Typing never trips this, and a field the engine
	 * would refuse commits nothing, so it is held rather than overwritten.
	 */
	if (!describes(fields, tool)) setFields(fieldsOf(tool));

	const { nameError, schemaError, outputSchemaError } = readFields(fields);

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

				<div className="space-y-3">
					<SchemaEditor
						labelId={SCHEMA_LABEL_ID}
						errorId={SCHEMA_ERROR_ID}
						label="Input schema"
						ariaLabel="MCP tool input schema"
						modelName="mcp-input-schema"
						requestId={requestId}
						value={fields.schema}
						error={schemaError}
						onChange={(schema) => edit({ ...fields, schema })}
					/>
					<SchemaEditor
						labelId={OUTPUT_LABEL_ID}
						errorId={OUTPUT_ERROR_ID}
						label="Output schema"
						hint="What the tool's structuredContent conforms to. A new Assert JSON Schema element starts from it."
						ariaLabel="MCP tool output schema"
						modelName="mcp-output-schema"
						requestId={requestId}
						value={fields.outputSchema}
						error={outputSchemaError}
						onChange={(outputSchema) => edit({ ...fields, outputSchema })}
					/>
				</div>
			</div>
		</div>
	);
}

interface SchemaEditorProps {
	labelId: string;
	errorId: string;
	label: string;
	hint?: string;
	ariaLabel: string;
	/** The editor's model name; one per schema so the two never share an undo stack. */
	modelName: EditorPane;
	requestId: string | null;
	value: string;
	error: string | null;
	onChange: (value: string) => void;
}

function SchemaEditor({
	labelId,
	errorId,
	label,
	hint,
	ariaLabel,
	modelName,
	requestId,
	value,
	error,
	onChange,
}: SchemaEditorProps) {
	return (
		<div
			role="group"
			aria-labelledby={labelId}
			aria-describedby={error ? errorId : undefined}
			className="space-y-2"
		>
			<p id={labelId} className="text-sm font-medium leading-none">
				{label}
			</p>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<div className="h-28 overflow-hidden rounded-md border border-input">
				<CodeEditor
					height="100%"
					language="json"
					ariaLabel={ariaLabel}
					path={requestModelPath(requestId, modelName)}
					value={value}
					onChange={(v) => onChange(v ?? "")}
				/>
			</div>
			<FieldError id={errorId}>{error}</FieldError>
		</div>
	);
}
