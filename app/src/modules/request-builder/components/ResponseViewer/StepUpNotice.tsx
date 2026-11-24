/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The response asks for more scope (#3766): a 403 whose `WWW-Authenticate` the engine classifies as
 * `insufficient_scope` (`POST /oauth2/step-up`), on a request whose own auth is OAuth 2.0. It names
 * the scopes and, for the authorization code grant, offers a sign-in asking for them beside the
 * held ones, then stores that scope in the config. Nothing retries itself: a load run cannot take a
 * browser step, so only a click re-authorizes. Here, not in the Auth tab, since this is where the
 * 403 is read and the context holds response and config; an inherited config is a collection's,
 * which this pane cannot write, so it gets nothing.
 */

import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { Callout } from "@/components/shared";
import { resolveOAuth2Config } from "@/components/shared/OAuth2Form/resolve-config";
import {
	useOAuth2SignIn,
	type OAuth2SignedIn,
} from "@/components/shared/OAuth2Form/useOAuth2SignIn";
import { useOAuth2StepUpQuery } from "@/queries/oauth";
import { discoveredValues, withDiscoveredValues } from "@/services/oauth/discovery";
import type { OAuth2Config, OAuth2StepUpResponse } from "@/types";
import { useRequestBuilderContext } from "../../context";
import type { ResponseState } from "../../types";
import { stepUpChallenges } from "./step-up";

export default function StepUpNotice({
	response,
	className,
}: {
	response: ResponseState;
	className?: string;
}) {
	const challenges = useMemo(() => stepUpChallenges(response), [response]);
	// Every response but a challenged 403 ends here, before the request is read.
	if (challenges.length === 0) return null;
	return <OwnConfigStepUp challenges={challenges} className={className} />;
}

function OwnConfigStepUp({ challenges, className }: { challenges: string[]; className?: string }) {
	const { request, resolveString } = useRequestBuilderContext();
	const config = request.auth.mode === "oauth2" ? request.auth.config : null;
	// The Auth tab's resolution and cache entries (`AuthPanel`'s `resolveKey`), so a sign-in here
	// posts what Get token would.
	const resolved = useMemo(
		() => (config ? resolveOAuth2Config(config, resolveString, request.id ?? "new") : null),
		[config, resolveString, request.id]
	);
	const { data } = useOAuth2StepUpQuery(
		resolved ? { wwwAuthenticate: challenges, scope: resolved.scope ?? "" } : null
	);

	if (!config || !resolved || !data?.stepUp) return null;
	return (
		<div className={className}>
			<StepUpCallout config={config} resolved={resolved} stepUp={data} />
		</div>
	);
}

function scopeList(scopes: string[]) {
	return scopes.map((scope, index) => (
		<span key={scope}>
			{index > 0 && (index === scopes.length - 1 ? " and " : ", ")}
			<code className="font-mono">{scope}</code>
		</span>
	));
}

function nextStep(interactive: boolean, named: boolean): string {
	if (interactive)
		return named
			? " Re-authorize signs in again asking for them too."
			: " Re-authorize signs in again.";
	return named ? " Add them to Scope in the Auth tab, then get a new token." : "";
}

/**
 * Its own component, so the sign-in (holding the config's sign-in key while mounted) exists only
 * with a step-up to act on.
 */
function StepUpCallout({
	config,
	resolved,
	stepUp,
}: {
	config: OAuth2Config;
	resolved: OAuth2Config;
	stepUp: OAuth2StepUpResponse;
}) {
	const { updateField } = useRequestBuilderContext();

	// The scope written is the one signed in with; a discovered start's filled members are written
	// as the Auth tab's sign-in writes them.
	const store: OAuth2SignedIn = (result, sent) => {
		const scoped = { ...config, scope: sent.scope };
		const next = result.resolved
			? withDiscoveredValues(scoped, discoveredValues(sent, result.resolved))
			: scoped;
		updateField("auth", { mode: "oauth2", config: next });
	};
	const signin = useOAuth2SignIn(resolved, store);
	const interactive = config.grantType === "authorization_code";
	const named = stepUp.requiredScopes.length > 0;

	return (
		<Callout
			severity="info"
			title="More scope needed"
			action={
				interactive && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => void signin.signIn({ ...resolved, scope: stepUp.scope })}
						disabled={signin.authorizing}
					>
						{signin.authorizing ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<RefreshCw className="size-icon-sm" />
						)}
						Re-authorize
					</Button>
				)
			}
		>
			{named ? (
				<>The server needs {scopeList(stepUp.requiredScopes)} for this request.</>
			) : (
				<>The server refused the token&apos;s scope without naming the one it needs.</>
			)}
			{nextStep(interactive, named)}
		</Callout>
	);
}
