/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one map from a kind to a bespoke form (issue #1512). A kind absent
 * here renders through {@link GenericElementForm} instead - the extensibility
 * contract's whole point: a kind the app has never seen is still editable.
 *
 * Phase 0 ships a bespoke form for every `script.*` kind - `script.pre` /
 * `script.post` and, since issue #1499, `script.setup` / `script.teardown` -
 * so a script keeps its Monaco editor rather than becoming a plain text
 * field. `extract.json`'s path field is deliberately generic-form only for
 * now (a bespoke response-body picker is real UI work with no engine
 * dependency, so it is a follow-up rather than part of this cut).
 */

import type { ComponentType } from "react";
import { ScriptElementForm, type ScriptElementFormProps } from "./ScriptElementForm";

export type ElementFormProps = ScriptElementFormProps;

export const ELEMENT_FORM_OVERRIDES: Record<string, ComponentType<ElementFormProps>> = {
	"script.pre": ScriptElementForm,
	"script.post": ScriptElementForm,
	"script.setup": ScriptElementForm,
	"script.teardown": ScriptElementForm,
};
