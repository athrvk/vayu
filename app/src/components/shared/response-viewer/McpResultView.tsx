/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The MCP tool result above the raw reply in the request builder's Body tab (#3841): `content[]`
 * blocks as what they are, `structuredContent` as a JSON body, `isError` as a banner.
 * `readMcpResult` reads; this draws. It renders nothing for a reply the pane cannot read whole (one
 * the engine capped or storage truncated, or one without a text view), as a half-read envelope
 * would show a result the server did not send; the raw body is always below. Every string is the
 * server's: text is never markup, an image is an `<img>` over its bytes and only for `image/*`, a
 * link a button handing an http(s) URL to the system browser. Audio is named and sized, not played:
 * the renderer's policy has no `media-src`, so `default-src 'self'` refuses a `data:` or `blob:`
 * source (`electron/renderer-csp.ts`).
 */

import { useMemo } from "react";
import { AudioLines, FileQuestion, FileText, Link2 } from "lucide-react";
import { Eyebrow } from "@/components/ui/eyebrow";
import { formatBytes } from "@/lib/format-number";
import { httpUrlOf, openExternal } from "@/lib/open-external";
import {
	bytesFromBase64,
	type ResponseBytes,
} from "@/modules/request-builder/utils/response-bytes";
import { Callout } from "../Callout";
import { ImagePreview } from "./ImagePreview";
import ResponseBody from "./ResponseBody";
import {
	base64ByteLength,
	readMcpResult,
	type McpContentBlock,
	type McpResult,
} from "./mcp-result";

export interface McpResultViewProps {
	body: string;
	bodyRaw?: string;
	rawBytes?: ResponseBytes;
	/** The body is a prefix: the engine stopped reading it, or storage cut it. */
	incomplete?: boolean;
}

const JSON_HEADERS = { "content-type": "application/json" };

export default function McpResultView({ body, bodyRaw, rawBytes, incomplete }: McpResultViewProps) {
	const text = bodyRaw || body;
	const hasNoText = rawBytes ? !rawBytes.isText : false;
	const result = useMemo(
		() => (incomplete || hasNoText ? null : readMcpResult(text)),
		[incomplete, hasNoText, text]
	);
	if (!result) return null;

	return (
		<section
			aria-label="MCP result"
			className="shrink-0 max-h-[50%] overflow-auto border-b border-rule"
		>
			<div className="flex flex-col gap-3 px-4 py-3">
				{result.kind === "error" ? (
					<ProtocolError result={result} />
				) : (
					<ToolResult result={result} />
				)}
			</div>
		</section>
	);
}

function ProtocolError({ result }: { result: Extract<McpResult, { kind: "error" }> }) {
	const code = result.code === undefined ? "" : ` (code ${result.code})`;
	return (
		<Callout severity="blocking" title="Server returned an error">
			{`${result.message}${code}`}
		</Callout>
	);
}

function ToolResult({ result }: { result: Extract<McpResult, { kind: "result" }> }) {
	const { isError, blocks, structuredContent } = result;
	return (
		<>
			{isError && (
				<Callout severity="blocking" title="Tool reported an error">
					The server set isError on this result. The content below says what went wrong.
				</Callout>
			)}
			{blocks.map((block, index) => (
				// Blocks have no id and never reorder; the reply is replaced whole.
				<ContentBlock key={index} block={block} />
			))}
			{structuredContent !== undefined && <StructuredContent value={structuredContent} />}
		</>
	);
}

function ContentBlock({ block }: { block: McpContentBlock }) {
	switch (block.kind) {
		case "text":
			return <TextBlock text={block.text} />;
		case "image":
			return <ImageBlock mimeType={block.mimeType} data={block.data} />;
		case "audio":
			return (
				<MediaNote
					icon={<AudioLines className="size-icon" />}
					label={`Audio (${block.mimeType}), ${formatBytes(base64ByteLength(block.data))}`}
					note="Audio playback isn't available here."
				/>
			);
		case "resource_link":
			return (
				<ResourceRef
					uri={block.uri}
					label={block.title ?? block.name}
					detail={[block.mimeType, block.description].filter(Boolean).join(" - ")}
				/>
			);
		case "resource":
			return <EmbeddedResource block={block} />;
		case "unknown":
			return (
				<MediaNote
					icon={<FileQuestion className="size-icon" />}
					label={block.type ? `Content of type "${block.type}"` : "Content block"}
					note="This block isn't shown here. It is in the raw reply below."
				/>
			);
	}
}

function TextBlock({ text }: { text: string }) {
	return (
		<pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
			{text}
		</pre>
	);
}

function ImageBlock({ mimeType, data }: { mimeType: string; data: string }) {
	// Only a declared image type is drawn; the type is the server's word.
	const bytes = useMemo(() => {
		if (!mimeType.toLowerCase().startsWith("image/")) return null;
		try {
			return bytesFromBase64(data);
		} catch {
			return null;
		}
	}, [mimeType, data]);

	if (!bytes) {
		return (
			<MediaNote
				icon={<FileQuestion className="size-icon" />}
				label={`Image (${mimeType})`}
				note="This image can't be shown."
			/>
		);
	}
	return (
		<div className="max-h-[400px] overflow-auto">
			<ImagePreview bytes={bytes} contentType={mimeType} alt="Image from the tool result" />
		</div>
	);
}

function EmbeddedResource({ block }: { block: Extract<McpContentBlock, { kind: "resource" }> }) {
	return (
		<div className="flex flex-col gap-2">
			<ResourceRef uri={block.uri} label="Resource" detail={block.mimeType ?? ""} />
			{block.text !== undefined && <TextBlock text={block.text} />}
			{block.blob !== undefined && (
				<MediaNote
					icon={<FileText className="size-icon" />}
					label={`Binary content, ${formatBytes(base64ByteLength(block.blob))}`}
					note="This content isn't shown here."
				/>
			)}
		</div>
	);
}

/**
 * A URI from the server: always shown as text, and a button only when it is
 * http(s). Never an `<a href>`, which would navigate the renderer.
 */
function ResourceRef({ uri, label, detail }: { uri: string; label?: string; detail: string }) {
	const url = httpUrlOf(uri);
	return (
		<div className="flex items-start gap-2 text-xs">
			<Link2 className="size-icon shrink-0 mt-px text-muted-foreground" aria-hidden="true" />
			<div className="min-w-0 flex flex-col gap-0.5">
				{label && <span className="font-medium text-foreground">{label}</span>}
				{url ? (
					<button
						type="button"
						title={url}
						onClick={() => void openExternal(url)}
						className="text-left font-mono break-all text-primary-text underline underline-offset-2 transition-opacity hover:opacity-80"
					>
						{uri}
					</button>
				) : (
					<span className="font-mono break-all text-foreground">{uri}</span>
				)}
				{detail && <span className="text-muted-foreground">{detail}</span>}
			</div>
		</div>
	);
}

function MediaNote({ icon, label, note }: { icon: React.ReactNode; label: string; note: string }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			{icon}
			<span>
				{label}. {note}
			</span>
		</div>
	);
}

function StructuredContent({ value }: { value: unknown }) {
	const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
	return (
		<div className="flex flex-col gap-1.5">
			<Eyebrow>Structured content</Eyebrow>
			<div className="h-48 border border-rule">
				<ResponseBody body={json} headers={JSON_HEADERS} showModeToggle={false} />
			</div>
		</div>
	);
}
