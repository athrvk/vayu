/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useRef } from "react";

/**
 * The image, from an object URL over its own bytes, revoked when they change
 * or the preview unmounts. Set on the element in the effect rather than held in
 * state, so a StrictMode remount creates a fresh URL instead of keeping the one
 * its first cleanup revoked.
 */
export function ImagePreview({
	bytes,
	contentType,
	alt = "Response",
}: {
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string;
	/** What the image is, for a screen reader; "Response" is the Body tab's. */
	alt?: string;
}) {
	const ref = useRef<HTMLImageElement>(null);
	useEffect(() => {
		const img = ref.current;
		if (!img) return;
		const url = URL.createObjectURL(new Blob([bytes], { type: contentType || "image/png" }));
		img.src = url;
		return () => {
			img.removeAttribute("src");
			URL.revokeObjectURL(url);
		};
	}, [bytes, contentType]);

	return <img ref={ref} alt={alt} className="max-w-full h-auto border border-rule" />;
}
