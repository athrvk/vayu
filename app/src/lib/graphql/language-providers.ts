/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Registers main-thread Monaco language providers for the `graphql` language,
 * backed by graphql-language-service and the active schema from the schema
 * cache. Call once after loader.config.
 */

import type * as Monaco from "monaco-editor";
import {
	getAutocompleteSuggestions,
	getHoverInformation,
	Position,
} from "graphql-language-service";
import { computeGraphqlDiagnostics } from "./diagnostics";
import { useSchemaCache } from "./schema-cache";

const MARKER_OWNER = "graphql";
const DEBOUNCE_MS = 250;

export function registerGraphqlProviders(monaco: typeof Monaco): void {
	const toSeverity = (s: "error" | "warning") =>
		s === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error;

	const runDiagnostics = (model: Monaco.editor.ITextModel) => {
		if (model.getLanguageId() !== "graphql") return;
		const markers = computeGraphqlDiagnostics(
			model.getValue(),
			useSchemaCache.getState().getActiveSchema()
		);
		monaco.editor.setModelMarkers(
			model,
			MARKER_OWNER,
			markers.map((m) => ({ ...m, severity: toSeverity(m.severity) }))
		);
	};

	const timers = new WeakMap<Monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
	const scheduleDiagnostics = (model: Monaco.editor.ITextModel) => {
		const prev = timers.get(model);
		if (prev) clearTimeout(prev);
		timers.set(
			model,
			setTimeout(() => runDiagnostics(model), DEBOUNCE_MS)
		);
	};

	monaco.editor.onDidCreateModel((model) => {
		if (model.getLanguageId() !== "graphql") return;
		runDiagnostics(model);
		model.onDidChangeContent(() => scheduleDiagnostics(model));
	});

	// Re-run diagnostics for open graphql models when the active schema changes.
	useSchemaCache.subscribe(() => {
		for (const model of monaco.editor.getModels()) {
			if (model.getLanguageId() === "graphql") runDiagnostics(model);
		}
	});

	monaco.languages.registerCompletionItemProvider("graphql", {
		triggerCharacters: [" ", ":", "(", "\n", "{", "@", "$"],
		provideCompletionItems(model, position) {
			const schema = useSchemaCache.getState().getActiveSchema();
			if (!schema) return { suggestions: [] };
			const word = model.getWordUntilPosition(position);
			const range = {
				startLineNumber: position.lineNumber,
				endLineNumber: position.lineNumber,
				startColumn: word.startColumn,
				endColumn: word.endColumn,
			};
			const items = getAutocompleteSuggestions(
				schema,
				model.getValue(),
				new Position(position.lineNumber - 1, position.column - 1)
			);
			return {
				suggestions: items.map((it) => ({
					label: it.label,
					kind: monaco.languages.CompletionItemKind.Field,
					insertText: it.insertText ?? it.label,
					detail: it.detail,
					documentation:
						typeof it.documentation === "string" ? it.documentation : undefined,
					range,
				})),
			};
		},
	});

	monaco.languages.registerHoverProvider("graphql", {
		provideHover(model, position) {
			const schema = useSchemaCache.getState().getActiveSchema();
			if (!schema) return null;
			const info = getHoverInformation(
				schema,
				model.getValue(),
				new Position(position.lineNumber - 1, position.column - 1)
			);
			const text = typeof info === "string" ? info : String(info ?? "");
			return text ? { contents: [{ value: text }] } : null;
		},
	});
}
