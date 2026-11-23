/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bespoke form for `assert.jsonschema` (#3806): what to check, which value
 * to take, and the schema to hold it to.
 *
 * **Why not the generic form.** Two things in the kind's contract are
 * conditions on a value, which its schema cannot say. `path` is read only while
 * `source` is `jsonpath`, and the engine refuses a `path` beside any other
 * source, so the field is drawn only for a JSONPath check and a switch back to
 * the whole body takes the path out of `config` with it. And `schema` is a
 * document: it takes the generic form's own typeless-value field, laid out as a
 * multi-line editor, rather than a one-line input.
 *
 * Every field is still the generic form's, over a subset of the kind's schema,
 * so titles, hints, error messages and the select all arrive unchanged
 * (`ModeElementForm` and `ScriptElementForm` do the same).
 */

import type { ElementFormProps } from "./elementForms";
import { GenericElementForm, JsonValueField } from "./GenericElementForm";
import { subsetSchema } from "./schema-subset";

const NO_ERRORS: Readonly<Record<string, string>> = {};

/** `config` without `path`: the engine reads one only while `source` is `jsonpath`. */
function withoutPath(config: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(config).filter(([key]) => key !== "path"));
}

export function JsonSchemaElementForm({
	schema,
	config,
	errors = NO_ERRORS,
	onChange,
}: ElementFormProps) {
	const properties = schema?.properties ?? {};
	const readsPath = config.source === "jsonpath";
	const schemaProperty = properties.schema;
	const source = subsetSchema(properties, schema?.required, ["source"]);
	const path = subsetSchema(properties, schema?.required, ["path"]);

	return (
		<div className="space-y-2">
			<GenericElementForm
				schema={source}
				config={config}
				errors={errors}
				onChange={(next) => onChange(next.source === "jsonpath" ? next : withoutPath(next))}
			/>
			{readsPath && (
				<GenericElementForm
					schema={path}
					config={config}
					errors={errors}
					onChange={onChange}
				/>
			)}
			<JsonValueField
				label={schemaProperty?.title ?? "schema"}
				hint={schemaProperty?.description}
				value={config.schema}
				error={errors.schema}
				multiline
				onChange={(value) => onChange({ ...config, schema: value })}
			/>
		</div>
	);
}
