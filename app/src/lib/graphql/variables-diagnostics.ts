/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Variables pane's JSON diagnostics, computed on masked text.
 *
 * The pane's header badge says a `{{token}}` is resolved and sent, and the
 * editor underneath painted it red - the same self-contradiction #384 found in
 * the query pane, one surface over. The query pane's fix does not transfer,
 * because there the parse is ours (`computeGraphqlDiagnostics`) and here it
 * happens inside Monaco's JSON worker.
 *
 * **So the worker is given a document it can parse, and the visible model shows
 * that verdict.** A hidden twin model holds the pane's text with every
 * out-of-string token masked into a same-length JSON string; the worker
 * validates the twin as it would any JSON model, and its markers are copied onto
 * the real model minus the ones that land on a masked token. Positions carry
 * across unchanged because the mask preserves length.
 *
 * Why not the two cheaper routes:
 *
 * - **Filtering the worker's markers on the real model** does not work, and the
 *   worker's own output is why. For `{"limit": {{n}}}` it reports three markers:
 *   `Incorrect type` over the token, `Property expected` inside it, and
 *   `End of file expected` on the character *after* it - so an overlap filter
 *   leaves a squiggle behind. Worse, the parse stops there: a genuine error
 *   later in the same document is reported for the twin and was reported
 *   nowhere at all before this.
 * - **Turning JSON validation off** is a property of the language, not of a
 *   model (`jsonDefaults.setDiagnosticsOptions`), so it would silence every JSON
 *   editor in the app, and silence them exactly when the text is most likely to
 *   have a real mistake in it.
 *
 * The cost of this shape is that the worker still validates the visible model
 * too, ~500ms after each edit, and writes its own markers there. That write
 * fires `onDidChangeMarkers`, which is what this listens to, so the correction
 * lands in the same turn - the wrong markers exist between two synchronous
 * statements, never across a paint.
 */

import type * as Monaco from "monaco-editor";
import { maskJsonTemplatesInPlace, rangesOverlap, type TemplateSpan } from "./templates";

/**
 * The owner Monaco's JSON worker publishes markers under - its language id.
 *
 * The same owner is written back deliberately: markers replace per owner, so
 * publishing the corrected set under a name of our own would leave the worker's
 * set beside it and show every squiggle twice.
 */
const JSON_MARKER_OWNER = "json";

/** The URI of the masked twin for a variables model. */
export function templateTwinUri(variablesModelUri: string): string {
	return `${variablesModelUri}.vayu-masked.json`;
}

/** Drop the markers the mask itself earned; keep every marker the user earned. */
export function markersOutsideTemplates<T extends TemplateSpan>(
	markers: T[],
	spans: TemplateSpan[]
): T[] {
	if (spans.length === 0) return markers;
	return markers.filter((marker) => !spans.some((span) => rangesOverlap(marker, span)));
}

/**
 * Point the variables model's JSON markers at a masked twin of its text, for as
 * long as the returned handle is not disposed.
 */
export function attachVariablesDiagnostics(
	monaco: typeof Monaco,
	model: Monaco.editor.ITextModel
): Monaco.IDisposable {
	const twinUri = monaco.Uri.parse(templateTwinUri(model.uri.toString()));
	// A twin left behind by a previous attach (a hot reload, or a model URI
	// reused after an unmount) would make createModel throw on a live URI.
	monaco.editor.getModel(twinUri)?.dispose();

	let spans: TemplateSpan[] = [];
	const twin = monaco.editor.createModel(maskedText(), "json", twinUri);

	function maskedText(): string {
		const { masked, spans: found } = maskJsonTemplatesInPlace(model.getValue());
		spans = found;
		return masked;
	}

	/*
	 * Re-mask, and only write when the masked text actually moved: typing inside
	 * a token changes the pane's text without changing its mask, and a needless
	 * setValue would re-run the worker and blink the pane's markers off and on.
	 */
	const pushText = () => {
		const masked = maskedText();
		if (twin.getValue() !== masked) twin.setValue(masked);
	};

	const pullMarkers = () => {
		if (model.isDisposed() || twin.isDisposed()) return;
		const next = markersOutsideTemplates(
			monaco.editor.getModelMarkers({ resource: twin.uri, owner: JSON_MARKER_OWNER }),
			spans
		).map(toMarkerData);
		const current = monaco.editor.getModelMarkers({
			resource: model.uri,
			owner: JSON_MARKER_OWNER,
		});
		// Writing markers fires the event that got us here, so an unconditional
		// write would be an endless loop rather than a settled state.
		if (sameMarkers(current, next)) return;
		monaco.editor.setModelMarkers(model, JSON_MARKER_OWNER, next);
	};

	const watched = new Set([model.uri.toString(), twinUri.toString()]);
	const listeners: Monaco.IDisposable[] = [
		model.onDidChangeContent(pushText),
		monaco.editor.onDidChangeMarkers((resources) => {
			if (resources.some((resource) => watched.has(resource.toString()))) pullMarkers();
		}),
		model.onWillDispose(() => dispose()),
	];

	let disposed = false;
	function dispose() {
		if (disposed) return;
		disposed = true;
		for (const listener of listeners) listener.dispose();
		if (!twin.isDisposed()) twin.dispose();
	}

	pullMarkers();
	return { dispose };
}

function toMarkerData(marker: Monaco.editor.IMarker): Monaco.editor.IMarkerData {
	return {
		severity: marker.severity,
		message: marker.message,
		startLineNumber: marker.startLineNumber,
		startColumn: marker.startColumn,
		endLineNumber: marker.endLineNumber,
		endColumn: marker.endColumn,
		code: marker.code,
		source: marker.source,
	};
}

function sameMarkers(a: Monaco.editor.IMarkerData[], b: Monaco.editor.IMarkerData[]): boolean {
	return a.length === b.length && a.every((marker, i) => markerKey(marker) === markerKey(b[i]));
}

function markerKey(marker: Monaco.editor.IMarkerData): string {
	return [
		marker.severity,
		marker.message,
		marker.startLineNumber,
		marker.startColumn,
		marker.endLineNumber,
		marker.endColumn,
	].join(":");
}
