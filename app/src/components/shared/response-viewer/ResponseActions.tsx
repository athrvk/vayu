/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy and download at the right of a response tab strip, mounted only by the request builder's
 * pane (the history viewer has neither). The caller passes the body as received (`receivedBody`),
 * never Pretty's indented copy: both hand back what the server sent (#2459). The file is named from
 * the response's Content-Type (`extensionForContentType`), text and bytes alike, so
 * `text/javascript` saves as `.js` and a text body with no usable subtype (absent,
 * `application/vnd...`) as `.txt`, never `.undefined`, and never `.bin` for something readable
 * (#3140). The copy feedback is `useCopy`'s (`TIMING.COPY_RESET_MS`). A base64 body (`rawBytes`,
 * #2458) downloads as its exact bytes under its Content-Type; its text, when it has one, is a
 * decoding, which Copy takes, and with none Copy says so rather than copying base64. A failed save
 * is a toast; a cancelled dialog is not (#3246).
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
import { downloadBlob, downloadTextFile, saveFailedMessage } from "@/lib/download-text-file";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores";
import {
	extensionForContentType,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";

export interface ResponseActionsProps {
	/** The text to copy and to download: the body as received, not its indented copy. */
	content: string;
	/**
	 * The body's exact bytes when the engine sent base64; Download writes them, typed and named by
	 * `contentType`.
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
	const showToast = useToastStore((s) => s.showToast);
	const noText = rawBytes !== undefined && !rawBytes.isText;

	const handleDownload = async () => {
		// Stamped at click time, not render time.
		const stamp = `response-${Date.now()}`;
		const type = contentType || "application/octet-stream";
		const fileName = rawBytes
			? `${stamp}.${extensionForContentType(type)}`
			: `${stamp}.${textExtension(contentType)}`;
		const saved = rawBytes
			? await downloadBlob(new Blob([rawBytes.data], { type }), fileName)
			: await downloadTextFile(content, fileName, "text/plain");
		if (saved.outcome === "failed") {
			showToast(saveFailedMessage(fileName, saved), "error");
		}
	};

	const copyButton = (
		<Button
			size="icon"
			variant="ghost"
			disabled={noText}
			onClick={() => void copy(content, "Response")}
			aria-label="Copy response"
		>
			{/*
			 * The check is the only sign the copy happened, and via `useCopy` a denied clipboard
			 * says so.
			 */}
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
						onClick={() => void handleDownload()}
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
