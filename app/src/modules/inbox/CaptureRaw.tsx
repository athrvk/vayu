/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A capture's raw HTTP text, and the way out for a body that is not text.
 *
 * The engine spells a body that is not valid UTF-8 as base64 (#3109). Printing
 * that string would show a protobuf or a gzip as a wall of letters that look
 * like a payload and are not, so the Raw view says what the body is and its
 * size, and Download and Copy hand over the exact bytes the engine stored.
 */

import { useMemo } from "react";
import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui";
import { buildRawRequest } from "@/components/shared/response-viewer/utils";
import { useCopy } from "@/hooks/useCopy";
import { downloadBlob } from "@/lib/download-text-file";
import {
	contentTypeOf,
	extensionForContentType,
} from "@/modules/request-builder/utils/response-bytes";
import type { InboxCapture } from "@/types";
import { binaryBodyPlaceholder, captureBinaryBytes } from "./utils";

interface CaptureRawProps {
	capture: InboxCapture;
	url: string;
}

const ACTION_CLASS = "h-control-sm gap-1.5 px-2 text-xs";

export function CaptureRaw({ capture, url }: CaptureRawProps) {
	const { copy } = useCopy();
	const isBinary = capture.bodyEncoding === "base64";
	const bytes = useMemo(() => captureBinaryBytes(capture), [capture]);

	// The placeholder follows the head with no body argument: `buildRawRequest`
	// would add a Content-Length for the placeholder's own text.
	const raw = isBinary
		? `${buildRawRequest(capture.method, url, capture.headers)}${binaryBodyPlaceholder(capture, bytes?.length)}`
		: buildRawRequest(capture.method, url, capture.headers, capture.body);

	const download = () => {
		if (!bytes) return;
		const type = contentTypeOf(capture.headers) || "application/octet-stream";
		downloadBlob(
			new Blob([bytes], { type }),
			`capture-${capture.id}.${extensionForContentType(type)}`
		);
	};

	return (
		<div className="flex min-h-0 flex-col gap-1">
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-muted-foreground">Raw</span>
				{isBinary && (
					<>
						{bytes && (
							<Button
								variant="ghost"
								size="sm"
								className={ACTION_CLASS}
								onClick={download}
							>
								<Download className="size-icon-sm" aria-hidden="true" />
								Download body
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							className={ACTION_CLASS}
							onClick={() => void copy(capture.body, "Body")}
						>
							<Copy className="size-icon-sm" aria-hidden="true" />
							Copy as base64
						</Button>
					</>
				)}
			</div>
			<pre className="max-h-48 overflow-auto surface-sunken border border-rule rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
				{raw}
			</pre>
		</div>
	);
}
