/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pure GraphQL diagnostics - monaco-free so it is unit-testable in node.
 * Positions are 1-based (Monaco convention); graphql-language-service emits
 * 0-based LSP ranges, converted here.
 *
 * **`{{variable}}` tokens are masked, not reported.** The editor completes them
 * and the engine resolves them, so marking every one as a syntax error was the
 * editor arguing with itself - and worse than cosmetic: an unmasked token is a
 * *parse* failure, which costs the rest of the document its validation. The
 * masked text parses, so everything else is still checked, and any marker that
 * lands on a placeholder is dropped because it is about a character the user
 * never typed. The mask is length-preserving, which is what makes the positions
 * that come back usable against the original text.
 */

import { parse, type GraphQLSchema } from "graphql";
import { getDiagnostics } from "graphql-language-service";
import { maskGraphqlTemplates, rangesOverlap, type TemplateSpan } from "./templates";

export interface GqlMarker {
	message: string;
	severity: "error" | "warning";
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export function computeGraphqlDiagnostics(text: string, schema: GraphQLSchema | null): GqlMarker[] {
	if (!text.trim()) {
		return [];
	}
	const { masked, spans } = maskGraphqlTemplates(text);
	// With a schema, getDiagnostics parses (syntax) and validates (field/type).
	// Without a schema, fall back to a parse-only syntax check.
	if (!schema) {
		try {
			parse(masked);
			return [];
		} catch (e: unknown) {
			const err = e as { locations?: { line: number; column: number }[]; message: string };
			const loc = err.locations?.[0] ?? { line: 1, column: 1 };
			return outsideTemplates(
				[
					{
						message: err.message,
						severity: "error",
						startLineNumber: loc.line,
						startColumn: loc.column,
						endLineNumber: loc.line,
						endColumn: loc.column + 1,
					},
				],
				spans
			);
		}
	}
	const diagnostics = getDiagnostics(masked, schema);
	return outsideTemplates(
		diagnostics.map((d) => ({
			// LSP diagnostics now type `message` as string | MarkupContent;
			// graphql-language-service emits plain strings, but coerce defensively.
			message: typeof d.message === "string" ? d.message : d.message.value,
			severity: d.severity === 2 ? "warning" : "error",
			startLineNumber: d.range.start.line + 1,
			startColumn: d.range.start.character + 1,
			endLineNumber: d.range.end.line + 1,
			endColumn: d.range.end.character + 1,
		})),
		spans
	);
}

/** Drop the markers the placeholder provoked; keep every marker the user earned. */
function outsideTemplates(markers: GqlMarker[], spans: TemplateSpan[]): GqlMarker[] {
	if (spans.length === 0) return markers;
	return markers.filter((m) => !spans.some((span) => rangesOverlap(m, span)));
}
