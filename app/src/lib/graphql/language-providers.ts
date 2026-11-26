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
import type { MonacoApi } from "../monaco-api";
import {
	CompletionItemKind,
	getAutocompleteSuggestions,
	getHoverInformation,
	Position,
} from "graphql-language-service";
import { computeGraphqlDiagnostics } from "./diagnostics";
import { formatGraphqlDocument } from "./format";
import { useSchemaCache } from "./schema-cache";
import { TIMING } from "@/config/timing";

const MARKER_OWNER = "graphql";
const DEBOUNCE_MS = TIMING.GRAPHQL_DIAGNOSTICS_DEBOUNCE_MS;

/**
 * LSP completion kind -> the name Monaco knows it by, so each suggestion `graphql-language-service`
 * classifies (fields, arguments, enum values, variables, directives) keeps its icon. Derived from
 * the enum rather than written out: the two enumerations agree on every name and disagree on every
 * number, so a hand-copied table is 25 chances to transpose two, and a transposition is a wrong
 * icon no test would think to check.
 */
const LSP_KIND_NAMES = new Map<number, string>(
	Object.entries(CompletionItemKind).map(([name, value]) => [value as number, name])
);

export function toMonacoCompletionKind(monaco: MonacoApi, lspKind: number | undefined): number {
	const kinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
	const name = lspKind === undefined ? undefined : LSP_KIND_NAMES.get(lspKind);
	// `Field` is the fallback: an unmapped kind gets the generic icon, never a missing one.
	return name !== undefined && name in kinds ? kinds[name] : kinds.Field;
}

export function registerGraphqlProviders(monaco: MonacoApi): void {
	const toSeverity = (s: "error" | "warning") =>
		s === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error;

	const runDiagnostics = (model: Monaco.editor.ITextModel) => {
		if (model.isDisposed() || model.getLanguageId() !== "graphql") return;
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
		// Cancel any pending debounce so it can't fire on a disposed model.
		model.onWillDispose(() => {
			const pending = timers.get(model);
			if (pending) clearTimeout(pending);
			timers.delete(model);
		});
	});

	// Re-run diagnostics for open graphql models only when the active schema
	// reference actually changes - the store also mutates on active-target/status
	// changes, which must not trigger a full re-validation pass.
	let lastSchema = useSchemaCache.getState().getActiveSchema();
	useSchemaCache.subscribe((state) => {
		const schema = state.activeKey ? (state.byKey[state.activeKey]?.schema ?? null) : null;
		if (schema === lastSchema) return;
		lastSchema = schema;
		for (const model of monaco.editor.getModels()) {
			if (model.getLanguageId() === "graphql") runDiagnostics(model);
		}
	});

	monaco.languages.registerCompletionItemProvider("graphql", {
		/*
		 * Structural triggers only, never space or newline. A trigger on "\n" or " " pops the
		 * suggestion widget, so the Enter that follows (meant as a newline) accepts the first
		 * suggestion instead. A space carries no structure in GraphQL: after `field ` the useful
		 * completions are the ones `{` and `(` already trigger, and typing a field name still shows
		 * suggestions through Monaco's quick-suggest.
		 */
		triggerCharacters: [":", "(", "{", "@", "$"],
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
					kind: toMonacoCompletionKind(monaco, it.kind),
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

	/*
	 * Enables the "Format Document" command (palette / Shift+Alt+F / right-click)
	 * for GraphQL. No-ops on unparseable input, and on a model that changed while
	 * the formatter was loading - that edit would land at stale offsets.
	 */
	monaco.languages.registerDocumentFormattingEditProvider("graphql", {
		async provideDocumentFormattingEdits(model) {
			const source = model.getValue();
			const formatted = await formatGraphqlDocument(source);
			if (formatted === null || model.isDisposed() || model.getValue() !== source) return [];
			return [{ range: model.getFullModelRange(), text: formatted }];
		},
	});
}
