/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The registry mapping a host to the client certificate Vayu presents to it (#707). An mTLS API is
 * uncallable without one, and the certificate belongs to *where you are calling*, not to one
 * request, so this is a list of hosts, not a request-builder field.
 *
 * A dedicated card, not a settings row, on the `CookiesCard` / `UpdatesCard` precedent: data with
 * its own CRUD routes, not a config entry the generic settings view can render. It sits in the
 * engine's "Network & connectivity" category with the rest of the transport policy (proxy, custom
 * CAs); anywhere else would be a second place to look for one story.
 *
 * **Paths, never file contents.** The renderer names a file and the engine opens it, which is why
 * the picker reads only `getFilePath`: the private key is never read here, sent over the wire or
 * stored in the database. The passphrase is the exception: stored (plaintext, the repo's credential
 * precedent) and never sent back, which is why an entry with one shows a badge, not a value.
 *
 * **Every row says what it reaches** (#803). A host matches exactly, and `*.example.com` matches
 * every subdomain but not `example.com`, which the pattern text does not say, so each row prints
 * the scope in words and the form states the wildcard form where the host is typed. The matching
 * stays in the engine: two copies of a rule about which certificate goes on a wire is one too many.
 *
 * **The format is a field, not a guess** (#833). A PEM certificate keeps its key in a second file;
 * a PKCS#12 bundle carries both. The engine has to be told which, or libcurl hands a bundle to its
 * PEM parser (#851). So the form asks, drops the key picker for a bundle (a card demanding a key
 * file the format lacks is a dead end), and every row prints what it will present, as the engine
 * may have read the format off the file and the user is the one who can correct it.
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
	clientCertificateDeleteDescription,
	IconSwap,
	Input,
	Label,
	SecretInput,
	ToggleGroup,
	ToggleGroupItem,
	DialogCancelButton,
	TooltipIconButton,
} from "@/components/ui";
import {
	useClientCertificatesQuery,
	useCreateClientCertificateMutation,
	useDeleteClientCertificateMutation,
} from "@/queries";
import { EmptyState } from "@/components/shared";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { useToastStore } from "@/stores";
import { useTrashUndo } from "@/hooks/useTrashUndo";
import type { ClientCertificateFormat, ClientCertificateListEntry } from "@/types";
import { fileBaseName } from "@/lib/file-path";
import { appSetting } from "../app-settings";

// The anchor and heading come from the catalogue so search cannot offer a name
// this card does not print - see `app-settings.ts`.
const CLIENT_CERTIFICATES = appSetting("clientCertificates");

/** What an entry is called: the same `host` / `host:port` the engine traces. */
function targetLabel(certificate: ClientCertificateListEntry): string {
	return certificate.port === null ? certificate.host : `${certificate.host}:${certificate.port}`;
}

/** The one wildcard form the engine stores - see `matchSummary` (issue #803). */
function isWildcardHost(host: string): boolean {
	return host.startsWith("*.");
}

/**
 * What a row will and will not answer for, in one sentence (#803). Printed for every row, with the
 * negative half stated, because the pattern text is exactly what a reader guesses wrong:
 * `*.example.com` looks like it covers `example.com` and does not, and a plain host looks like it
 * covers its subdomains and does not. A certificate silently *not* presented is the failure this
 * registry exists to end, so the scope is on screen, not in the docs. No port: it is already the
 * row's title and badge, and this is about which *hosts* the entry reaches.
 */
function matchSummary(host: string): string {
	if (!isWildcardHost(host)) {
		return `Matches ${host} exactly - not its subdomains.`;
	}
	const domain = host.slice(2);
	return `Matches any subdomain of ${domain} (api.${domain}, a.b.${domain}) - not ${domain} itself.`;
}

/**
 * Each format's on-screen name and the files it needs, in one table, as the segmented control, the
 * row badge and the pickers describe the same choice. `accept` is a hint to the file dialog, never
 * a rule: the engine reads the format off the file's bytes and refuses a contradiction, so an oddly
 * named certificate is still registrable by typing its path.
 */
const FORMATS: Record<
	ClientCertificateFormat,
	{ label: string; badge: string; accept: string; needsKeyFile: boolean }
> = {
	pem: {
		label: "PEM + key file",
		badge: "PEM",
		accept: ".pem,.crt,.cer",
		needsKeyFile: true,
	},
	p12: {
		label: "PKCS#12 bundle",
		badge: "PKCS#12",
		accept: ".p12,.pfx",
		needsKeyFile: false,
	},
};

/**
 * A stored format's row name, falling back to the value itself. The engine refuses to *store* an
 * unknown format, so this fires only for a row hand-edited around the routes, which the engine
 * still lists (dropping it from the transport policy with a log line). Indexing straight into the
 * table would throw and take the whole Settings screen down over one bad row instead of showing
 * which row to fix.
 */
function formatBadge(certFormat: string): string {
	return FORMATS[certFormat as ClientCertificateFormat]?.badge ?? certFormat;
}

/** The empty draft, and what "Cancel" restores. */
const EMPTY_DRAFT = {
	host: "",
	port: "",
	certPath: "",
	keyPath: "",
	passphrase: "",
	certFormat: "pem" as ClientCertificateFormat,
};

/**
 * A file the user picks, reduced to its absolute path. `getFilePath` reads the path off the `File`
 * and reports it to main as a picked file, so the renderer gains no ability to name paths of its
 * own. Outside Electron it answers `""`, and the field stays empty rather than hold a path that
 * does not exist.
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
	const { data: certificates = [], isError, isLoading } = useClientCertificatesQuery();
	const createCertificate = useCreateClientCertificateMutation();
	const deleteCertificate = useDeleteClientCertificateMutation();
	const showToast = useToastStore((s) => s.showToast);
	const offerUndo = useTrashUndo();

	const [draft, setDraft] = useState(EMPTY_DRAFT);
	const [adding, setAdding] = useState(false);
	const [confirming, setConfirming] = useState<ClientCertificateListEntry | null>(null);

	const closeForm = () => {
		setAdding(false);
		setDraft(EMPTY_DRAFT);
	};

	const needsKeyFile = FORMATS[draft.certFormat].needsKeyFile;

	const submit = async () => {
		try {
			await createCertificate.mutateAsync({
				host: draft.host.trim(),
				// "" is "every port", which the engine spells as null. Parsed
				// here rather than sent as text so a typo is a client-side
				// nothing rather than a 400 the user has to decode.
				port: draft.port.trim() === "" ? null : Number(draft.port.trim()),
				certPath: draft.certPath.trim(),
				certFormat: draft.certFormat,
				// A bundle carries its own key, and the engine refuses a row
				// that names one - so this is null rather than a path the form
				// happens to still hold from before the format was switched.
				keyPath: needsKeyFile ? draft.keyPath.trim() : null,
				passphrase: draft.passphrase === "" ? undefined : draft.passphrase,
			});
			showToast(`Client certificate registered for ${draft.host.trim()}`, "success");
			closeForm();
		} catch (error) {
			// The engine's message names what is wrong (an unreadable file, a host with a scheme, a
			// target already registered), and only it can, so it is kept beside the fallback
			// context, not replaced by it.
			showToast(
				error instanceof Error
					? `Couldn't register the certificate - ${error.message}`
					: "Couldn't register the certificate",
				"error"
			);
		}
	};

	const remove = async (certificate: ClientCertificateListEntry) => {
		setConfirming(null);
		try {
			await deleteCertificate.mutateAsync(certificate.id);
			offerUndo(certificate.id, targetLabel(certificate), "clientCertificate");
		} catch {
			showToast("Couldn't remove the certificate", "error");
		}
	};

	// The empty state carries its own add link; this card's button would be a
	// second path to the same form.
	const listIsEmpty = !isError && !isLoading && certificates.length === 0;

	const canSubmit =
		draft.host.trim() !== "" &&
		draft.certPath.trim() !== "" &&
		(!needsKeyFile || draft.keyPath.trim() !== "");

	return (
		// The anchor pointers elsewhere aim at: the curl-paste ledger's `--cert` / `--key` entries
		// (#708) reveal this card as settings search reveals a config row, through
		// `useRevealedSetting`, which scrolls it into view and outlines it.
		<Card data-setting-anchor={CLIENT_CERTIFICATES.anchor}>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<KeyRound className="w-5 h-5 text-muted-foreground" />
					<CardTitle>{CLIENT_CERTIFICATES.label}</CardTitle>
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
						{ENGINE_NO_ANSWER} The registered certificates are unknown until Vayu's
						engine answers.
					</p>
				) : isLoading ? null : listIsEmpty ? (
					<EmptyState
						variant="inline"
						title="Register a certificate for a host that requires mutual TLS."
						action={
							adding ? undefined : (
								<Button variant="link" onClick={() => setAdding(true)}>
									Add certificate
								</Button>
							)
						}
					/>
				) : (
					<div>
						{certificates.map((certificate) => (
							// A flat hairline row, not a boxed card per entry: the repeated-item
							// list convention of the app (`RunItem`, `SampleRequestCard`).
							<div
								key={certificate.id}
								className="border-b border-rule py-3 last:border-b-0 flex items-start justify-between gap-4"
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
										{/* Printed for every row, not only the
										    unusual one: the engine may have read
										    this off the file, and what will be
										    presented is the fact worth showing. */}
										<Badge variant="chip" className="text-muted-foreground">
											{formatBadge(certificate.certFormat)}
										</Badge>
										{certificate.hasPassphrase && (
											<Badge variant="chip" className="text-muted-foreground">
												Passphrase set
											</Badge>
										)}
										{/* The engine drops an entry it cannot present from
										    every send without a word, so this is the one
										    place the user learns a registered row is inert.
										    Fill and white label, as the connection test's
										    outcome chip. */}
										{!certificate.usable && (
											<Badge
												variant="chip"
												className="bg-status-warning-fill text-white"
											>
												Not presented
											</Badge>
										)}
									</div>
									{!certificate.usable && (
										<p className="text-xs text-status-warning-text">
											Skipped on every send
											{certificate.problem ? ` - ${certificate.problem}` : ""}
										</p>
									)}
									{/* What this row reaches, spelled out - the pattern
									    text alone is what a reader guesses wrong. */}
									<p className="text-xs text-muted-foreground">
										{matchSummary(certificate.host)}
									</p>
									{/* The basename reads; the full path is the title,
									    because two `client.pem` in different directories
									    are different certificates. */}
									<div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground font-mono">
										<span title={certificate.certPath}>
											{fileBaseName(certificate.certPath)}
										</span>
										{/* A bundle stores no key path, so there is no
									    second name to print - an empty span would
									    read as a file whose name went missing. */}
										{certificate.keyPath !== "" && (
											<span title={certificate.keyPath}>
												{fileBaseName(certificate.keyPath)}
											</span>
										)}
									</div>
								</div>
								<TooltipIconButton
									size="sm"
									onClick={() => setConfirming(certificate)}
									disabled={deleteCertificate.isPending}
									label={`Remove the certificate for ${targetLabel(certificate)}`}
									tooltip="Remove certificate"
									icon={<Trash2 className="size-icon" />}
								/>
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
						{/* The wildcard form is stated where the host is typed, not only
						    on the row it produces: a user who never learns it exists
						    registers one entry per service and adds one per new service. */}
						<p className="text-xs text-muted-foreground">
							A host matches exactly. Write{" "}
							<code className="font-mono">*.example.com</code> to answer for every
							subdomain instead - <code className="font-mono">api.example.com</code>{" "}
							and deeper, never <code className="font-mono">example.com</code> itself.
						</p>

						<div className="space-y-1.5">
							<span className="block text-sm font-medium leading-none">Format</span>
							<ToggleGroup
								size="sm"
								aria-label="Certificate format"
								value={draft.certFormat}
								// Radix clears the value when the active segment is
								// pressed again; a format has no "off".
								onValueChange={(next) =>
									next &&
									setDraft((d) => ({
										...d,
										certFormat: next as ClientCertificateFormat,
									}))
								}
							>
								{(Object.keys(FORMATS) as ClientCertificateFormat[]).map(
									(format) => (
										<ToggleGroupItem key={format} value={format}>
											{FORMATS[format].label}
										</ToggleGroupItem>
									)
								)}
							</ToggleGroup>
							<p className="text-xs text-muted-foreground">
								A PKCS#12 bundle holds the certificate and its key in one file. Both
								forms work on every platform.
							</p>
						</div>

						<PathPicker
							id="client-cert-path"
							label="Certificate file"
							value={draft.certPath}
							accept={FORMATS[draft.certFormat].accept}
							onPick={(path) => setDraft((d) => ({ ...d, certPath: path }))}
						/>
						{/* Absent for a bundle rather than disabled: the engine
						    refuses a PKCS#12 entry that names a key file, so a
						    greyed-out field would be asking for something that
						    can never be sent. */}
						{needsKeyFile && (
							<div className="enter-fade">
								<PathPicker
									id="client-cert-key-path"
									label="Private key file"
									value={draft.keyPath}
									accept=".pem,.key"
									onPick={(path) => setDraft((d) => ({ ...d, keyPath: path }))}
								/>
							</div>
						)}

						<div className="space-y-1.5">
							<Label htmlFor="client-cert-passphrase">
								{needsKeyFile
									? "Key passphrase (optional)"
									: "Bundle password (optional)"}
							</Label>
							<SecretInput
								id="client-cert-passphrase"
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
							<DialogCancelButton size="sm" onClick={closeForm} />
							<Button
								size="sm"
								onClick={() => void submit()}
								disabled={!canSubmit || createCertificate.isPending}
							>
								{/* Swapped, not mounted: a spinner that mounts widens
								    the button and slides Cancel beside it. */}
								<IconSwap
									state={createCertificate.isPending ? "adding" : "idle"}
									icons={{
										idle: <Plus className="size-icon" />,
										adding: <Loader2 className="size-icon animate-spin" />,
									}}
								/>
								Add certificate
							</Button>
						</div>
					</div>
				) : listIsEmpty ? null : (
					<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
						<Plus className="size-icon" />
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
					confirming ? clientCertificateDeleteDescription(targetLabel(confirming)) : ""
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
