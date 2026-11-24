/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bespoke form for `assert.snapshot` (#3807): which list the reply holds,
 * and the baseline it is held to.
 *
 * **Why not the generic form.** `baseline` is an array of objects whose schema
 * declares no `items` type, and the generic form's array field is a
 * comma-separated list of scalars. A baseline is a document (a recorded
 * `tools/list` runs to hundreds of lines), so it takes the generic form's own
 * typeless-value field, laid out as a multi-line editor, as `assert.jsonschema`'s
 * schema does. Typed text that is not JSON is stored as a string, which
 * `OPERAND_RULES` holds back from the save.
 *
 * `method` is still the generic form's select over a subset of the kind's
 * schema, so its title, hint and options arrive unchanged.
 */

import type { ElementFormProps } from "./elementForms";
import { GenericElementForm, JsonValueField } from "./GenericElementForm";
import { subsetSchema } from "./schema-subset";

const NO_ERRORS: Readonly<Record<string, string>> = {};

export function SnapshotElementForm({
	schema,
	config,
	errors = NO_ERRORS,
	onChange,
}: ElementFormProps) {
	const properties = schema?.properties ?? {};
	const baseline = properties.baseline;
	const method = subsetSchema(properties, schema?.required, ["method"]);

	return (
		<div className="space-y-2">
			<GenericElementForm
				schema={method}
				config={config}
				errors={errors}
				onChange={onChange}
			/>
			<JsonValueField
				label={baseline?.title ?? "baseline"}
				hint={baseline?.description}
				value={config.baseline}
				error={errors.baseline}
				multiline
				onChange={(value) => onChange({ ...config, baseline: value })}
			/>
		</div>
	);
}
