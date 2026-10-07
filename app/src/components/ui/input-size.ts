/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A text field's height, one floor token per `size` (#1830). `Input` and
 * `VariableInput` both read it, so the two fields cannot drift apart: a
 * key-value row's `VariableInput` and the variables table's `Input` are one
 * row pitch because both say `size="sm"`. A field states a size, never a
 * height class (`chrome-floors.test.ts`).
 */
export const INPUT_HEIGHT = {
	default: "h-control",
	sm: "h-control-sm",
	xs: "h-control-xs",
} as const;

export type InputSize = keyof typeof INPUT_HEIGHT;
