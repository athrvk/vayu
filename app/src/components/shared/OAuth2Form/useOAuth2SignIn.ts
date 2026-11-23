/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";
import {
	runInteractiveAuthorization,
	type InteractiveAuthResult,
} from "@/services/oauth/authorize";
import { oauth2SignInKey } from "@/services/oauth/discovery";
import { systemNotify, NOTIFY_KINDS } from "@/services/notify";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { useToastStore } from "@/stores";
import { oauthSignin, useIsSigningIn } from "@/stores/oauth-signin-store";
import type { OAuth2Config } from "@/types";

/**
 * What a surface does with a sign-in that landed: write what it learned back
 * into the stored config. @p sent is the config the start posted.
 */
export type OAuth2SignedIn = (result: InteractiveAuthResult, sent: OAuth2Config) => void;

/**
 * The interactive Authorization Code sign-in for @p config (resolved), shared
 * by every surface that can start one. The sign-in belongs to the config, not
 * the surface (`oauth-signin-store`): two surfaces for one config share it,
 * and the last to unmount stops it.
 *
 * @p onSignedIn is called only while the surface still shows a config with the
 * key the sign-in ran under. A sign-in lasts minutes in a browser, so by the
 * time it lands the surface may show another request or be gone, and a write
 * then would land on a config the sign-in was not for.
 */
export function useOAuth2SignIn(config: OAuth2Config, onSignedIn?: OAuth2SignedIn) {
	const showToast = useToastStore((s) => s.showToast);
	const queryClient = useQueryClient();
	const key = useMemo(() => oauth2SignInKey(config), [config]);
	const authorizing = useIsSigningIn(key);
	useEffect(() => (key ? oauthSignin.acquire(key) : undefined), [key]);

	const current = useRef<{ key: string | null; onSignedIn?: OAuth2SignedIn }>({ key: null });
	useEffect(() => {
		current.current = { key, onSignedIn };
		return () => {
			current.current = { key: null };
		};
	});

	// Engine-hosted loopback + PKCE; opens the system browser (or the embedded
	// window when the config opts in). @p sent is @p config unless the caller
	// signs in with a member changed (a step-up's scope).
	const signIn = async (sent: OAuth2Config = config) => {
		if (!key) return;
		const signal = oauthSignin.begin(key);
		if (!signal) return;
		let result: InteractiveAuthResult | undefined;
		try {
			result = await runInteractiveAuthorization(sent, signal);
			// A cancelled sign-in has nothing to report: whoever cancelled knows.
			if (signal.aborted) return;
			queryClient.invalidateQueries({ queryKey: queryKeys.oauth.token(result.cacheKey) });
			showToast("Authorized", "success");
			// The loopback flow puts the user in their browser by design, so
			// this is the one success they are guaranteed not to be looking at
			// (#1358). The click brings them back to the request they left.
			systemNotify.post({
				kind: NOTIFY_KINDS.signedIn,
				title: "Signed in",
				body: "Back to Vayu to continue.",
			});
		} catch (err) {
			if (signal.aborted) return;
			showToast(
				err instanceof Error ? humanizeOAuth2Error(err.message) : "Authorization failed",
				"error"
			);
			return;
		} finally {
			oauthSignin.end(key, signal);
		}
		// After `end`: the write can change the config's key, and a key change
		// while the sign-in was still registered would release and cancel it.
		if (result && current.current.key === key) current.current.onSignedIn?.(result, sent);
	};

	const cancel = () => {
		if (key) oauthSignin.cancel(key);
	};

	return { key, authorizing, signIn, cancel };
}
