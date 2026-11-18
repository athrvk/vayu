/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The fields only the `jwt_bearer` grant (RFC 7523, #3632) has: whom the
 * assertion is about and for, the key it is signed with, and the claims riding
 * along. `clientId` is the assertion's `iss` and stays the form's own field.
 *
 * **The key is one control with two sources**, a `{{variable}}` reference
 * (`privateKey`) or a file (`privateKeyFile`), and exactly one is ever set:
 * choosing one clears the other. The reference is never resolved here - the
 * engine reads it from the scopes a token request names - and a pasted PEM is
 * refused before it reaches the config, because a key typed into a field would
 * be saved with the request, exported and sent in the clear. A file is picked
 * through `useFilePick`, which is what records the engine's grant for it.
 */

import { useCallback, useMemo, useState } from "react";
import { FileUp, X } from "lucide-react";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	TooltipIconButton,
} from "@/components/ui";
import { OAUTH2_FIELD_LABELS } from "@/constants/oauth2-fields";
import { holdsPem, singleReferenceName } from "@/services/oauth/signing-key";
import type { OAuth2Config, OAuth2ParamRow, VariableSupport } from "@/types";
import { FieldError } from "../FieldError";
import { LabelledField } from "../LabelledField";
import { useFilePick, type PickedFile } from "../file-pick";
import ParamRowsEditor from "./ParamRowsEditor";
import SecondsInput from "./SecondsInput";
import type { OAuth2TextInput } from "./types";

const DEFAULT_LIFETIME_SECONDS = 180;
const MAX_LIFETIME_SECONDS = 3600;

const PEM_REFUSAL =
	"A private key can't be typed into a field. Put it in a secret variable and enter that variable's name here, or choose a key file.";
const NO_PATH_REFUSAL =
	"This window can't read the file's path, so it can't be used as a key file. Choose it in the desktop app.";

interface JwtBearerFieldsProps {
	value: OAuth2Config;
	onChange: (next: OAuth2Config) => void;
	TextInput: OAuth2TextInput;
	variables?: VariableSupport;
}

/** @p value without @p member, so an unset member is absent rather than `""`. */
function without(value: OAuth2Config, member: "privateKey" | "privateKeyFile"): OAuth2Config {
	const { [member]: _dropped, ...rest } = value;
	return rest;
}

/** The hint under the key: what it takes, or what is wrong with the variable it names. */
function keyHint(referenced: string | null, notSecret: boolean): string {
	if (referenced && notSecret) {
		return `${referenced} is not marked secret. Mark it secret so its value stays masked.`;
	}
	return "One variable that holds the PEM and is marked secret, written {{name}}, or a key file.";
}

function SigningKeyField({ value, onChange, TextInput, variables }: JwtBearerFieldsProps) {
	const [problem, setProblem] = useState<string | null>(null);

	const typeReference = (text: string) => {
		if (holdsPem(text)) {
			setProblem(PEM_REFUSAL);
			return;
		}
		setProblem(null);
		const rest = without(value, "privateKeyFile");
		onChange(text === "" ? without(rest, "privateKey") : { ...rest, privateKey: text });
	};

	const pickFile = useCallback(
		(file: PickedFile) => {
			// Outside Electron a pick has a name and no path, and a name is not
			// something the engine can open.
			if (!file.src) {
				setProblem(NO_PATH_REFUSAL);
				return;
			}
			setProblem(null);
			onChange({ ...without(value, "privateKey"), privateKeyFile: file.src });
		},
		[onChange, value]
	);
	const { open, inputProps } = useFilePick(pickFile);

	const referenced = singleReferenceName(value.privateKey);
	const notSecret = useMemo(() => {
		const definition = referenced ? variables?.getAllVariables()[referenced] : undefined;
		return definition !== undefined && !definition.secret;
	}, [referenced, variables]);

	const file = value.privateKeyFile;
	return (
		<LabelledField
			label={OAUTH2_FIELD_LABELS.privateKey}
			hint={keyHint(referenced, notSecret)}
			className="space-y-1.5"
		>
			{(c) => (
				<>
					<div className="flex items-center gap-2">
						<input {...inputProps} />
						<div className="min-w-0 flex-1">
							{file ? (
								<Input
									id={c.id}
									readOnly
									value={file}
									title={file}
									className="font-mono text-sm"
								/>
							) : (
								<TextInput
									{...c}
									value={value.privateKey ?? ""}
									onChange={typeReference}
									placeholder="{{private_key}}"
								/>
							)}
						</div>
						<Button type="button" variant="outline" size="sm" onClick={open}>
							<FileUp className="size-icon-sm" />
							{file ? "Replace file" : "Choose file"}
						</Button>
						{file && (
							<TooltipIconButton
								size="sm"
								label="Remove key file"
								onClick={() => onChange(without(value, "privateKeyFile"))}
								icon={<X className="size-icon-sm" />}
							/>
						)}
					</div>
					<FieldError>{problem}</FieldError>
				</>
			)}
		</LabelledField>
	);
}

export default function JwtBearerFields(props: JwtBearerFieldsProps) {
	const { value, onChange, TextInput, variables } = props;

	const setText = (member: "subject" | "assertionAudience" | "keyId", text: string) =>
		onChange({ ...value, [member]: text });
	const setClaims = (rows: OAuth2ParamRow[] | undefined) => {
		const { assertionClaims: _previous, ...rest } = value;
		onChange(rows ? { ...rest, assertionClaims: rows } : rest);
	};
	const setLifetime = (seconds: number | undefined) => {
		const { assertionLifetimeSeconds: _previous, ...rest } = value;
		onChange(seconds === undefined ? rest : { ...rest, assertionLifetimeSeconds: seconds });
	};

	return (
		<>
			<div className="grid grid-cols-2 gap-4">
				<LabelledField label={OAUTH2_FIELD_LABELS.subject} className="space-y-1.5">
					{(c) => (
						<TextInput
							{...c}
							value={value.subject ?? ""}
							onChange={(v) => setText("subject", v)}
							placeholder="user or service account, or {{var}}"
						/>
					)}
				</LabelledField>
				<LabelledField
					label={OAUTH2_FIELD_LABELS.assertionAudience}
					hint="The assertion's aud claim, usually the token URL."
					className="space-y-1.5"
				>
					{(c) => (
						<TextInput
							{...c}
							value={value.assertionAudience ?? ""}
							onChange={(v) => setText("assertionAudience", v)}
							placeholder="https://idp.example.com/token"
						/>
					)}
				</LabelledField>
			</div>

			<SigningKeyField {...props} />

			<div className="grid grid-cols-3 gap-4">
				<LabelledField label="Signing algorithm" className="space-y-1.5">
					{(c) => (
						<Select
							value={value.signingAlgorithm ?? "RS256"}
							onValueChange={(signingAlgorithm: "RS256" | "ES256") =>
								onChange({ ...value, signingAlgorithm })
							}
						>
							<SelectTrigger id={c.id}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="RS256">RS256</SelectItem>
								<SelectItem value="ES256">ES256</SelectItem>
							</SelectContent>
						</Select>
					)}
				</LabelledField>
				<LabelledField label="Key ID" className="space-y-1.5">
					{(c) => (
						<TextInput
							{...c}
							value={value.keyId ?? ""}
							onChange={(v) => setText("keyId", v)}
							placeholder="optional"
						/>
					)}
				</LabelledField>
				<LabelledField
					label="Assertion lifetime (seconds)"
					hint={`1 to ${MAX_LIFETIME_SECONDS}.`}
					className="space-y-1.5"
				>
					{(c) => (
						<SecondsInput
							id={c.id}
							value={value.assertionLifetimeSeconds}
							onChange={setLifetime}
							placeholder={String(DEFAULT_LIFETIME_SECONDS)}
							min={1}
							max={MAX_LIFETIME_SECONDS}
						/>
					)}
				</LabelledField>
			</div>

			<ParamRowsEditor
				label="Extra claims"
				hint="Added to the assertion beside iss, sub, aud, exp and iat, which Vayu writes itself."
				rows={value.assertionClaims}
				onChange={setClaims}
				variables={variables}
			/>
		</>
	);
}
