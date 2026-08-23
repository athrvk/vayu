/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Name-and-confirm for "save this response as an example" (issue #588), at the
 * `StartMockServerDialog` scale: one field, the facts the save carries, and the
 * engine's refusal shown where the form is.
 *
 * It names rather than saves silently because the name is the only thing the
 * Examples panel lists, and "200 OK" three times over is a list you cannot read.
 *
 * The mutation lives here rather than in the caller, which is the other way
 * round from `StartMockServerDialog`: there the parent owns a success toast and
 * a running/stopped switch either way, and here success means only "close".
 * Keeping it in also keeps `ResponseViewer` - a pane that redraws on every send
 * - from needing a query client for a feature that exists inside a modal.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogBody,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { formatSize } from "@/components/shared/response-viewer";
import { useCreateRequestExampleMutation } from "@/queries";
import { isCommitEnter } from "@/lib/keyboard";
import { defaultExampleName, exampleFromResponse } from "./save-as-example";
import type { ResponseState } from "../../types";

export interface SaveAsExampleDialogProps {
	/** The saved request the example is nested under. */
	requestId: string;
	/** The response being kept - status, headers, body, and its truncation. */
	response: ResponseState;
	/**
	 * Mounted only while open, like `StartMockServerDialog`: the mount is the
	 * reset, so the name field starts from this response's status line every
	 * time rather than carrying the last attempt - or its error - over.
	 */
	onClose: () => void;
}

export function SaveAsExampleDialog({ requestId, response, onClose }: SaveAsExampleDialogProps) {
	const [name, setName] = useState(() => defaultExampleName(response));
	const save = useCreateRequestExampleMutation();

	const trimmed = name.trim();
	const pending = save.isPending;
	const canSave = trimmed.length > 0 && !pending;

	const onSave = () => {
		if (!canSave) return;
		save.mutate(
			{ requestId, example: exampleFromResponse(response, trimmed) },
			{ onSuccess: onClose }
		);
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Save response as example</DialogTitle>
					<DialogDescription>
						Kept against this request with its status, headers and body - the same shape
						an import stores, and what a mock server for this collection can answer
						with.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4 py-2">
					<div className="space-y-1">
						<Label htmlFor="example-name" className="leading-snug">
							Name
							<span className="block text-xs font-normal text-muted-foreground">
								What the Examples tab lists this response as.
							</span>
						</Label>
						<Input
							id="example-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (isCommitEnter(e)) onSave();
							}}
							aria-invalid={trimmed.length === 0}
							autoFocus
						/>
					</div>

					{/*
					 * A restored run's body may be only the slice the engine kept
					 * (`maxTraceBodyBytes`), and a mock serves an example as though it
					 * were a whole response. Said before the save, not after - and the
					 * default name carries it onto the row, which is the only part the
					 * panel shows once this dialog is gone.
					 */}
					{response.bodyTruncated && (
						<Callout severity="warning" title="This body is not the whole response">
							Only the first {formatSize(response.body.length)} of{" "}
							{formatSize(response.bodyBytes ?? response.body.length)} was kept when
							the run was stored, and that is what gets saved. Re-send the request
							first to keep the complete body.
						</Callout>
					)}

					{/*
					 * The ordering contract, stated where the save happens: the mock
					 * answers with the first example of a matched route, an append never
					 * takes that position, and a running mock reloads nothing until it
					 * is restarted.
					 */}
					<p className="text-xs text-muted-foreground">
						Added after the request&apos;s existing examples, so a mock server keeps
						answering with the same one. A running mock picks this up when it is
						restarted.
					</p>

					{save.error && (
						<Callout severity="blocking" title="Could not save the example">
							{save.error.message}
						</Callout>
					)}
				</DialogBody>

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={onSave} disabled={!canSave}>
						{pending && (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
						)}
						Save example
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default SaveAsExampleDialog;
