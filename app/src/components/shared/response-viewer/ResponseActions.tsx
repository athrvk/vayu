/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy and download, the pair that sits at the right of a response tab strip.
 *
 * Only the request builder's response pane mounts it; the history viewer has no
 * copy or download. The caller passes the body as received (`receivedBody`),
 * never the indented copy the Pretty view reads: Copy and Download hand back
 * what the server sent (issue #2459).
 *
 * The file is named after the response's own Content-Type
 * (`extensionForContentType`), the same rule for a text and a byte body, so a
 * `text/javascript` body saves as `.js` and a type with no usable subtype
 * (absent, or an `application/vnd...` label) saves a text body as `.txt`,
 * never `response-1234.undefined` and never `.bin` for something readable
 * (issue #3140).
 *
 * The tick-for-a-moment feedback is `useCopy`'s (`TIMING.COPY_RESET_MS`) for the
 * whole app.
 *
 * A body the engine sent as base64 (`rawBytes`, issue #2458) downloads as its
 * exact bytes under the response's own Content-Type; its text, when it has
 * one, is a decoding and is what Copy takes. One with no text has nothing to
 * copy, so Copy says so instead of copying base64.
 */

import { Copy, Check, Download } from "lucide-react";
import {
	Button,
	DisabledHint,
	IconSwap,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	ICON_MOTION,
} from "@/components/ui";
import { useCopy } from "@/hooks/useCopy";
import { downloadBlob, downloadTextFile } from "@/lib/download-text-file";
import { cn } from "@/lib/utils";
import {
	extensionForContentType,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";

export interface ResponseActionsProps {
	/** The text to copy and to download: the body as received, not its indented copy. */
	content: string;
	/**
	 * The body's exact bytes, when the engine sent it as base64. Download then
	 * writes them, typed and named by `contentType`.
	 */
	rawBytes?: ResponseBytes;
	/** The response's Content-Type: names the file, and types a `rawBytes` download. */
	contentType?: string;
	className?: string;
}

/** `bin` is right for unreadable bytes, not for text the user can open. */
function textExtension(contentType: string): string {
	const extension = extensionForContentType(contentType);
	return extension === "bin" ? "txt" : extension;
}

export function ResponseActions({
	content,
	rawBytes,
	contentType = "",
	className,
}: ResponseActionsProps) {
	const { copy, copied } = useCopy({ feedback: "icon" });
	const noText = rawBytes !== undefined && !rawBytes.isText;

	const handleDownload = () => {
		// Stamped at click time, not render time.
		const stamp = `response-${Date.now()}`;
		if (rawBytes) {
			const type = contentType || "application/octet-stream";
			const blob = new Blob([rawBytes.data], { type });
			downloadBlob(blob, `${stamp}.${extensionForContentType(type)}`);
			return;
		}
		downloadTextFile(content, `${stamp}.${textExtension(contentType)}`, "text/plain");
	};

	const copyButton = (
		<Button
			size="icon"
			variant="ghost"
			disabled={noText}
			onClick={() => void copy(content, "Response")}
			aria-label="Copy response"
		>
			{/* The check is the only feedback that the copy happened -
			    and, through `useCopy`, a denied clipboard now says so
			    instead of leaving the glyph untouched. */}
			<IconSwap
				state={copied ? "copied" : "copy"}
				icons={{
					copy: <Copy className="size-icon-sm" />,
					copied: <Check className="size-icon-sm text-status-success-text" />,
				}}
			/>
		</Button>
	);

	return (
		<div className={cn("flex items-center gap-1 shrink-0", className)}>
			{noText ? (
				<DisabledHint reason="Binary body, no text to copy">{copyButton}</DisabledHint>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>{copyButton}</TooltipTrigger>
					<TooltipContent>Copy response</TooltipContent>
				</Tooltip>
			)}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						onClick={handleDownload}
						aria-label="Download response"
					>
						<Download className="size-icon-sm" data-icon-motion={ICON_MOTION.drop} />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Download response</TooltipContent>
			</Tooltip>
		</div>
	);
}

export default ResponseActions;
