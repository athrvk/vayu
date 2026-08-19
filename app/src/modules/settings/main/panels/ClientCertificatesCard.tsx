/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ClientCertificatesCard
 *
 * The registry that maps a host to the client certificate Vayu presents to it
 * (issue #707). An mTLS API is uncallable without one, and the certificate is a
 * property of *where you are calling* rather than of one request - so this is a
 * list of hosts, not a field on the request builder.
 *
 * A dedicated card rather than a settings row, on the `CookiesCard` /
 * `UpdatesCard` precedent: it is data with its own CRUD routes, not a config
 * entry the engine's generic settings view can render. It sits in the engine's
 * "Network & connectivity" category because that is where the rest of the
 * transport policy lives (proxy, custom CAs), and a certificate registry
 * anywhere else would be a second place to look for one story.
 *
 * **Paths, never file contents.** The renderer names a file and the engine
 * opens it, which is why the picker reads only `getFilePath` - the private key
 * is never read here, never sent over the wire and never stored in the
 * database. The passphrase is the exception: it is stored (plaintext, the
 * repo's existing credential precedent) and, once stored, never sent back -
 * which is why an entry that has one shows a badge and not a value.
 */

import { useRef, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	DeleteConfirmDialog,
	Input,
	Label,
	SecretInput,
} from "@/components/ui";
import {
	useClientCertificatesQuery,
	useCreateClientCertificateMutation,
	useDeleteClientCertificateMutation,
} from "@/queries";
import { useToastStore } from "@/stores";
import type { ClientCertificate } from "@/types";
import { fileBaseName } from "@/lib/file-path";

/** What an entry is called: the same `host` / `host:port` the engine traces. */
function targetLabel(certificate: ClientCertificate): string {
	return certificate.port === null ? certificate.host : `${certificate.host}:${certificate.port}`;
}

/** The empty draft, and what "Cancel" restores. */
const EMPTY_DRAFT = { host: "", port: "", certPath: "", keyPath: "", passphrase: "" };

/**
 * A file the user picks, reduced to its absolute path.
 *
 * `getFilePath` is a preload-local read of the `File` object, not an IPC
 * channel - the renderer gains no ability to name paths of its own. Outside
 * Electron it answers `""`, and the field then stays empty rather than being
 * filled with a path that does not exist.
 */
function PathPicker({
	id,
	label,
	value,
	accept,
	onPick,
}: {
	id: string;
	label: string;
	value: string;
	accept: string;
	onPick: (path: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<div className="flex items-center gap-2">
				<Input
					id={id}
					value={value}
					onChange={(e) => onPick(e.target.value)}
					placeholder="/path/to/file.pem"
					className="font-mono text-xs"
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => inputRef.current?.click()}
				>
					Browse
				</Button>
			</div>
			<input
				ref={inputRef}
				type="file"
				accept={accept}
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					// Re-picking the same file is not a change event without this.
					event.target.value = "";
					if (!file) return;
					const path = window.electronAPI?.getFilePath(file) ?? "";
					if (path) onPick(path);
				}}
			/>
		</div>
	);
}

export function ClientCertificatesCard() {
	const { data: certificates = [], isError } = useClientCertificatesQuery();
	const createCertificate = useCreateClientCertificateMutation();
	const deleteCertificate = useDeleteClientCertificateMutation();
	const showToast = useToastStore((s) => s.showToast);

	const [draft, setDraft] = useState(EMPTY_DRAFT);
	const [adding, setAdding] = useState(false);
	const [confirming, setConfirming] = useState<ClientCertificate | null>(null);

	const closeForm = () => {
		setAdding(false);
		setDraft(EMPTY_DRAFT);
	};

	const submit = async () => {
		try {
			await createCertificate.mutateAsync({
				host: draft.host.trim(),
				// "" is "every port", which the engine spells as null. Parsed
				// here rather than sent as text so a typo is a client-side
				// nothing rather than a 400 the user has to decode.
				port: draft.port.trim() === "" ? null : Number(draft.port.trim()),
				certPath: draft.certPath.trim(),
				keyPath: draft.keyPath.trim(),
				passphrase: draft.passphrase === "" ? undefined : draft.passphrase,
			});
			showToast(`Client certificate registered for ${draft.host.trim()}`, "success");
			closeForm();
		} catch (error) {
			// The engine's message names what is wrong - an unreadable file, a
			// host that carries a scheme, a target already registered - and it is
			// the only thing that can, so it is shown rather than replaced.
			showToast(
				error instanceof Error ? error.message : "Could not register the certificate",
				"error"
			);
		}
	};

	const remove = async (certificate: ClientCertificate) => {
		setConfirming(null);
		try {
			await deleteCertificate.mutateAsync(certificate.id);
			showToast(`Removed the certificate for ${targetLabel(certificate)}`, "success");
		} catch {
			showToast("Could not remove the certificate", "error");
		}
	};

	const canSubmit =
		draft.host.trim() !== "" && draft.certPath.trim() !== "" && draft.keyPath.trim() !== "";

	return (
		// The anchor a pointer elsewhere in the app aims at - the curl-paste
		// ledger's `--cert` / `--key` entries (#708) reveal this card the same
		// way the settings search reveals a config row. Read by
		// `useRevealedSetting`, which scrolls it into view and outlines it.
		<Card data-setting-anchor="clientCertificates">
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<KeyRound className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">Client certificates</CardTitle>
				</div>
				<CardDescription>
					Certificates Vayu presents to hosts that require mutual TLS. A registered host
					is matched on every outbound path - sends, load runs, streams, scripts and OAuth
					token requests - so no request has to name one. Vayu stores the file paths and
					reads them at send time; the private key never enters its database.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isError ? (
					<p className="text-sm text-muted-foreground">
						The engine did not answer, so the registered certificates are unknown.
					</p>
				) : certificates.length === 0 ? (
					<p className="text-sm text-muted-foreground">No certificates registered.</p>
				) : (
					<div className="space-y-2">
						{certificates.map((certificate) => (
							<div
								key={certificate.id}
								className="rounded-md border border-rule surface-sunken p-3 flex items-start justify-between gap-4"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-foreground">
											{targetLabel(certificate)}
										</span>
										{certificate.port === null && (
											<Badge variant="chip" className="text-muted-foreground">
												Every port
											</Badge>
										)}
										{certificate.hasPassphrase && (
											<Badge variant="chip" className="text-muted-foreground">
												Passphrase set
											</Badge>
										)}
									</div>
									{/* The basename reads; the full path is the title,
									    because two `client.pem` in different directories
									    are different certificates. */}
									<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground font-mono">
										<span title={certificate.certPath}>
											{fileBaseName(certificate.certPath)}
										</span>
										<span title={certificate.keyPath}>
											{fileBaseName(certificate.keyPath)}
										</span>
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setConfirming(certificate)}
									disabled={deleteCertificate.isPending}
									aria-label={`Remove the certificate for ${targetLabel(certificate)}`}
								>
									<Trash2 className="w-4 h-4" />
								</Button>
							</div>
						))}
					</div>
				)}

				{adding ? (
					<div className="rounded-md border border-rule p-3 space-y-3">
						<div className="grid grid-cols-[2fr_1fr] gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="client-cert-host">Host</Label>
								<Input
									id="client-cert-host"
									value={draft.host}
									onChange={(e) =>
										setDraft((d) => ({ ...d, host: e.target.value }))
									}
									placeholder="api.example.com"
									className="font-mono text-xs"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="client-cert-port">Port</Label>
								<Input
									id="client-cert-port"
									value={draft.port}
									onChange={(e) =>
										setDraft((d) => ({ ...d, port: e.target.value }))
									}
									placeholder="Every port"
									inputMode="numeric"
									className="font-mono text-xs"
								/>
							</div>
						</div>

						<PathPicker
							id="client-cert-path"
							label="Certificate file"
							value={draft.certPath}
							accept=".pem,.crt,.cer,.p12,.pfx"
							onPick={(path) => setDraft((d) => ({ ...d, certPath: path }))}
						/>
						<PathPicker
							id="client-cert-key-path"
							label="Private key file"
							value={draft.keyPath}
							accept=".pem,.key"
							onPick={(path) => setDraft((d) => ({ ...d, keyPath: path }))}
						/>

						<div className="space-y-1.5">
							<Label htmlFor="client-cert-passphrase">
								Key passphrase (optional)
							</Label>
							<SecretInput
								value={draft.passphrase}
								onChange={(value) => setDraft((d) => ({ ...d, passphrase: value }))}
								placeholder="Leave empty if the key has none"
							/>
							<p className="text-xs text-muted-foreground">
								Stored in Vayu&apos;s database as written, like every other saved
								credential.
							</p>
						</div>

						<div className="flex items-center justify-end gap-2">
							<Button variant="ghost" size="sm" onClick={closeForm}>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={() => void submit()}
								disabled={!canSubmit || createCertificate.isPending}
							>
								{createCertificate.isPending && (
									<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
								)}
								Add certificate
							</Button>
						</div>
					</div>
				) : (
					<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
						<Plus className="w-4 h-4 mr-1.5" />
						Add certificate
					</Button>
				)}
			</CardContent>

			<DeleteConfirmDialog
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open) setConfirming(null);
				}}
				title="Remove this certificate?"
				description={
					confirming
						? `Requests to ${targetLabel(confirming)} will be sent without a client certificate. The certificate and key files themselves are not touched.`
						: ""
				}
				onConfirm={() => {
					if (confirming !== null) void remove(confirming);
				}}
				confirmLabel="Remove"
				isDeleting={deleteCertificate.isPending}
			/>
		</Card>
	);
}
