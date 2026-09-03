/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Monaco theme name for the mode the app is in, kept in step with the
 * tokens behind it (#1321).
 *
 * Two things change what those tokens resolve to, and neither is React state:
 * the `dark` class and the `data-color-scheme` attribute, both written onto
 * `<html>` by `useElectronTheme` (and by `index.html` before React mounts).
 * So the hook watches the element rather than a store.
 *
 * **The theme is redefined inside the observer callback, not in an effect.**
 * `<Editor>` is a child of `CodeEditor`, and a child's effects run before its
 * parent's, so an effect here would hand Monaco a name it has not been given
 * yet - and Monaco answers an unknown theme name by silently falling back to
 * `vs`, then never revisits it, because a later `defineTheme` only re-applies
 * the theme that is *currently* showing. Defining it in the callback puts the
 * registration before the re-render that carries the new name.
 */

import { useEffect, useRef, useState } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import type { MonacoApi } from "@/lib/monaco-api";
import {
	MONACO_THEME_NAMES,
	currentEditorMode,
	registerMonacoTheme,
	type MonacoThemeName,
} from "@/lib/monaco-theme";

function themeNameForDocument(): MonacoThemeName {
	return MONACO_THEME_NAMES[currentEditorMode()];
}

export function useMonacoTheme(): MonacoThemeName {
	const monaco = useLoadedMonaco();
	const [themeName, setThemeName] = useState<MonacoThemeName>(themeNameForDocument);
	const monacoRef = useRef<MonacoApi | null>(monaco);

	useEffect(() => {
		monacoRef.current = monaco;
		// Monaco arrived, or this editor mounted after a change that happened
		// while none was open: redefine under the name already on screen, which
		// is what makes Monaco re-apply it. The name itself cannot have moved -
		// nothing but the document's own attributes decides it, and the observer
		// below is what watches those.
		if (monaco) registerMonacoTheme(monaco);
	}, [monaco]);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			const loaded = monacoRef.current;
			setThemeName(loaded ? registerMonacoTheme(loaded) : themeNameForDocument());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			// The mode is a class; the accent scheme is an attribute. The scheme
			// moves `--primary`, which is the editor's selection colour, so
			// watching the class alone would leave a selection behind.
			attributeFilter: ["class", "data-color-scheme"],
		});
		return () => {
			observer.disconnect();
		};
	}, []);

	return themeName;
}
