/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy and download, the pair that sits at the right of a response tab strip.
 *
 * Duplicated between `ResponseViewer` and `UnifiedResponseViewer`: same two
 * buttons, same icons, same tick-for-a-moment feedback. The copies had already
 * drifted three ways, and each difference is a real one rather than an accident
 * of transcription, so all three are **props** here instead of a winner picked
 * between them:
 *
 *   - **What gets copied.** The request builder copies the formatted body; the
 *     history viewer prefers `bodyRaw` and falls back. Caller decides.
 *   - **What the file is called.** The request builder names it after the
 *     detected body type; history always used `.txt`, and has to keep doing so -
 *     `ResponseData` has no `bodyType` field at all, so unifying on it would
 *     have produced `response-1234.undefined` on every history download.
 *
 * The third difference, how long the tick lasts, is gone rather than a prop:
 * one copy used a shared status constant and the other a literal `2000`, and
 * the tick is now `useCopy`'s (`TIMING.COPY_RESET_MS`) for the whole app.
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
	/** The text to copy and to download. */
	content: string;
	/**
	 * Extension for the downloaded file, without the dot. Defaults to `txt`
	 * because that is what a caller with no detected type should get - never
	 * `undefined`.
	 */
	fileExtension?: string;
	/**
	 * The body's exact bytes, when the engine sent it as base64. Download then
	 * writes them, typed and named by `contentType`.
	 */
	rawBytes?: ResponseBytes;
	/** The response's Content-Type, for a `rawBytes` download. */
	contentType?: string;
	className?: string;
}

export function ResponseActions({
	content,
	fileExtension,
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
		downloadTextFile(content, `${stamp}.${fileExtension || "txt"}`, "text/plain");
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
