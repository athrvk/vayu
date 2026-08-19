/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The client-certificate registry card (issue #707).
 *
 * Two things are worth asserting beyond "it renders". The first is the shape of
 * what it sends: `port` is nullable and the engine treats `null` as "every
 * port", so a blank field that reached the engine as `0` or `""` would register
 * an entry matching nothing. The second is that a failed create shows the
 * engine's own message - it is the only thing that can say *why* (an unreadable
 * key file, a host that carries a scheme, a target already taken), and a card
 * that replaced it with "could not add" would send the user back to a form with
 * no idea which field is wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { ClientCertificatesCard } from "./ClientCertificatesCard";

/**
 * The passphrase field is a `SecretInput`, whose reveal toggle is a tooltip
 * button - the app mounts one provider at its root, so the card needs one here
 * rather than a stub of the primitive.
 */
function renderCard() {
	return render(
		<TooltipProvider>
			<ClientCertificatesCard />
		</TooltipProvider>
	);
}

const createMutate = vi.fn(() => Promise.resolve({}));
const deleteMutate = vi.fn(() => Promise.resolve());
const showToast = vi.fn();

const certificates = [
	{
		id: "cert_1",
		host: "api.example.com",
		port: 8443,
		certPath: "/home/ada/certs/client.pem",
		keyPath: "/home/ada/certs/client.key",
		certFormat: "pem" as const,
		hasPassphrase: true,
		createdAt: 1,
		updatedAt: 1,
	},
	{
		id: "cert_2",
		host: "internal.example.com",
		port: null,
		certPath: "/home/ada/certs/internal.p12",
		keyPath: "",
		certFormat: "p12" as const,
		hasPassphrase: false,
		createdAt: 1,
		updatedAt: 1,
	},
];

let queryResult: { data?: typeof certificates; isError: boolean } = {
	data: certificates,
	isError: false,
};

vi.mock("@/queries", () => ({
	useClientCertificatesQuery: () => queryResult,
	useCreateClientCertificateMutation: () => ({ mutateAsync: createMutate, isPending: false }),
	useDeleteClientCertificateMutation: () => ({ mutateAsync: deleteMutate, isPending: false }),
}));

vi.mock("@/stores", () => ({
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

beforeEach(() => {
	createMutate.mockClear();
	createMutate.mockImplementation(() => Promise.resolve({}));
	deleteMutate.mockClear();
	showToast.mockClear();
	queryResult = { data: certificates, isError: false };
});

/** Open the add form and fill the three required fields. */
function fillDraft({ host, port }: { host: string; port?: string }) {
	fireEvent.click(screen.getByRole("button", { name: /add certificate/i }));
	fireEvent.change(screen.getByLabelText("Host"), { target: { value: host } });
	if (port !== undefined) {
		fireEvent.change(screen.getByLabelText("Port"), { target: { value: port } });
	}
	fireEvent.change(screen.getByLabelText("Certificate file"), {
		target: { value: "/certs/client.pem" },
	});
	fireEvent.change(screen.getByLabelText("Private key file"), {
		target: { value: "/certs/client.key" },
	});
}

describe("ClientCertificatesCard", () => {
	it("names each entry by the target the engine matches on", () => {
		renderCard();

		// `host:port` and bare `host` - the same two spellings the engine writes
		// into a trace, so the response pane's chip and this list read as one.
		expect(screen.getByText("api.example.com:8443")).toBeInTheDocument();
		expect(screen.getByText("internal.example.com")).toBeInTheDocument();
		expect(screen.getByText("Every port")).toBeInTheDocument();
		// The passphrase is never sent back, so the only honest thing to show is
		// that one is set.
		expect(screen.getByText("Passphrase set")).toBeInTheDocument();
		expect(screen.getByText("client.pem")).toBeInTheDocument();
	});

	it("sends a blank port as null, which is what 'every port' is", async () => {
		renderCard();
		fillDraft({ host: "api.example.com" });
		fireEvent.click(screen.getByRole("button", { name: /^add certificate$/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		// `0` or `""` here registers an entry that can never match a transfer.
		expect(createMutate).toHaveBeenCalledWith({
			host: "api.example.com",
			port: null,
			certPath: "/certs/client.pem",
			certFormat: "pem",
			keyPath: "/certs/client.key",
			passphrase: undefined,
		});
	});

	it("sends a typed port as a number", async () => {
		renderCard();
		fillDraft({ host: "api.example.com", port: "8443" });
		fireEvent.click(screen.getByRole("button", { name: /^add certificate$/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({ port: 8443 }));
	});

	it("shows the engine's reason when a create is refused", async () => {
		createMutate.mockImplementation(() =>
			Promise.reject(
				new Error(
					"Invalid client certificate: key file '/certs/client.key' is not a readable file"
				)
			)
		);
		renderCard();
		fillDraft({ host: "api.example.com" });
		fireEvent.click(screen.getByRole("button", { name: /^add certificate$/i }));

		await waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(showToast).toHaveBeenCalledWith(
			expect.stringContaining("not a readable file"),
			"error"
		);
	});

	it("removes an entry by id, behind a confirmation", async () => {
		renderCard();

		fireEvent.click(
			screen.getByRole("button", { name: /remove the certificate for api.example.com:8443/i })
		);
		const dialog = await screen.findByRole("dialog");
		// The dialog says the files themselves survive - deleting a registry row
		// must not read as deleting the user's certificate.
		expect(within(dialog).getByText(/files themselves are not touched/i)).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

		await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith("cert_1"));
	});

	it("prints what each row will present, and no key file for a bundle", () => {
		renderCard();

		// The engine may have read the format off the file, so the row is where
		// a user finds out what will actually go on the wire (#833).
		expect(screen.getByText("PEM")).toBeInTheDocument();
		expect(screen.getByText("PKCS#12")).toBeInTheDocument();
		// A bundle stores no key path. An empty name here would read as a file
		// whose name went missing rather than as a format that has none.
		expect(screen.getByText("internal.p12")).toBeInTheDocument();
		expect(screen.getByText("client.key")).toBeInTheDocument();
	});

	it("drops the key file for a PKCS#12 entry and sends null in its place", async () => {
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: /add certificate/i }));
		fireEvent.change(screen.getByLabelText("Host"), {
			target: { value: "api.example.com" },
		});
		fireEvent.change(screen.getByLabelText("Certificate file"), {
			target: { value: "/certs/client.pem" },
		});
		// Fill the key first, then switch: the path is still in the draft, and
		// sending it would be a 400 from an engine that refuses a bundle naming
		// a key file.
		fireEvent.change(screen.getByLabelText("Private key file"), {
			target: { value: "/certs/client.key" },
		});
		fireEvent.click(screen.getByRole("radio", { name: /PKCS#12 bundle/i }));

		// Absent rather than disabled - a bundle has no key file to ask for.
		expect(screen.queryByLabelText("Private key file")).not.toBeInTheDocument();
		// And the field is not required to submit, which is the dead end this
		// change removes: a Windows user could fill in nothing that worked.
		fireEvent.click(screen.getByRole("button", { name: /^add certificate$/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalled());
		expect(createMutate).toHaveBeenCalledWith(
			expect.objectContaining({ certFormat: "p12", keyPath: null })
		);
	});

	it("says the engine did not answer rather than showing an empty registry", () => {
		queryResult = { data: undefined, isError: true };
		renderCard();

		// "No certificates registered" here would be a claim the card cannot
		// make - an unreachable engine holds whatever it holds.
		expect(screen.getByText(/did not answer/i)).toBeInTheDocument();
		expect(screen.queryByText(/no certificates registered/i)).not.toBeInTheDocument();
	});
});
