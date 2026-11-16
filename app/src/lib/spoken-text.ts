/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A displayed figure, as a live region should speak it. The shared formatters
 * write a value that rounds to nothing as `<0.01` or `<0.1%`, and a screen
 * reader may skip the symbol and speak a bare "0.01", which is a different
 * claim. Only a `<` before a digit is a figure's; any other is left alone.
 */
export function spokenSymbols(text: string): string {
	return text.replace(/<(?=\d)/g, "less than ");
}
