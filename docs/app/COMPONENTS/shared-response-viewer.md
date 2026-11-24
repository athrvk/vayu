---
description: >-
  The shared response viewer, auth fields and OAuth 2.0 form of the Vayu desktop app.
---

# Shared: Response Viewer and Auth

## Shared Response Viewer (`components/shared/response-viewer/`)

Response-rendering primitives reused outside the request builder (e.g. history detail):

- `UnifiedResponseViewer.tsx` - top-level response view for stored runs, and for an inbox capture. Given a `response` its first tab is **Response**, in a fixed 500px panel its callers cap; given only a `request` (a capture has no response, #3492) the first tab is **Body**, showing `request.body` (or `request.rawBytes` for a body with no text view) in panels that fill the card, with "No body" when it is empty. Beside a response, a request that carries a body gets a **Request** tab for it (the session Console's rows, #3634); a caller that passes no request body sees the tabs it always had. Its **Events** tab appears only when the caller passes an `events` node - a load run's captured stream (issue #657) - because almost every sampled row is not a stream, and a permanent tab reading "not an event stream" would be noise on all of them
- `ResponseBody.tsx` - body rendering (JSON/text/HTML/XML; SVG is XML). A body with no text view - `rawBytes` with `isText: false`, the decoded base64 the engine sends for a body that is not UTF-8 (issue #2458) - skips the editor under the same toolbar: an image is drawn from its bytes by `ImagePreview` (a Blob object URL revoked on unmount), and a PDF or other bytes are named with their size. Whether there is any text comes from the funnel's `rawBytes.isText`, not from a sniff of its own: an `octet-stream`, `zip` or `gzip` header over a body that arrived as UTF-8 (no `rawBytes`, or `isText`) stays in the editor as plain text rather than reading "Binary data", while an image or PDF header keeps its own pane either way (issue #3427). A decoding that replaced bytes or met an unknown charset gets a warning `Callout` over the text. Past `LARGE_BODY_BYTES` (2 MB, `utils.ts`) it drops to a **large-body mode**: no `formatBody`, no syntax highlighting, no Pretty/Raw/Preview toggle, and only the first 2 MB of the raw body in the editor, under an info `Callout` saying so (`LargeBodyNotice`, shared with the request builder's Raw tab, which applies the same cap to its own copy of the body). Everything this component does to a body it does synchronously during render - `formatBody`'s indent pass (a copy larger than its input), then Monaco tokenising the result - so a multi-megabyte response froze the window between Send and the pane painting. `formatBody` indents JSON with `lib/json-format.ts`, which copies the received text token by token without parsing a value, so member order, duplicate keys and integers past 2^53 show as the server sent them (issue #2459); the funnels hand it the received text, and Copy, Download and Save as example take that same text unchanged rather than the indented copy, and so does the Raw tab, which caps it at the same `LARGE_BODY_BYTES` (issue #3138) instead of formatting it. The Download half of the notice is worded against the `actions` slot, which the history viewer does not pass. Separate from the engine's `bodyCapped` notice (see the request builder's `ResponseViewer/`): this one is the *pane* declining to format what it was given, that one is the engine never having read more - both can be on screen at once
- `ImagePreview.tsx` - an image drawn from its bytes through a Blob object URL, revoked when they change or the preview unmounts. `ResponseBody`'s image pane and `McpResultView`'s image blocks both draw through it, with the `alt` each supplies.
- `McpResultView.tsx` + `mcp-result.ts` - the MCP tool result above the raw reply in the request builder's Body tab (#3841). `readMcpResult` (pure, `mcp-result.test.ts`) reads the body as the engine's raw reply: one JSON-RPC response, or a `text/event-stream` whose last `message` event carrying a `result` or `error` is the response (`engine/include/vayu/http/mcp_reply.hpp` is the engine's reader of the same two shapes). It answers `null` for anything that is not a tool result (a `tools/list` result, malformed text, a body past `LARGE_BODY_BYTES`), and the view also steps aside, rendering nothing, for a reply with `bodyCapped` or `bodyTruncated` or with no text view (`rawBytes.isText` false): a half-read envelope would show a result the server never sent, and the raw body is always below. Text blocks are `<pre>` text; an image block is drawn by `ImagePreview` only for an `image/*` type with valid base64, otherwise named; **audio is named with its type and size, not played**, because the renderer's CSP has no `media-src` and `default-src 'self'` refuses a `data:` or `blob:` source (`electron/renderer-csp.ts`); a resource link or an embedded resource's URI is text, a button handing it to `openExternal` only when it is http(s), never an `<a href>`; `structuredContent` is a `ResponseBody` over `JSON.stringify` (no mode toggle) under a "Structured content" label; `isError` is a blocking `Callout` ("Tool reported an error") above the blocks, and a JSON-RPC `error` envelope is the same tier ("Server returned an error", with its code). The section is `shrink-0 max-h-[50%] overflow-auto`, so the raw reply keeps the rest of the pane's height. Mounted by the request builder's `ResponseViewer` only when `request.bodyMode === "mcp"`; the History and Console mounts of the body pane do not know the request's mode and show the raw reply as before. → `McpResultView.test.tsx`, `ResponseViewer/mcp-result-view.test.tsx`
- `preview-document.ts` - the document the HTML **Preview** frame renders. The frame is `sandbox=""`, never `allow-same-origin`: the markup is the server's, and with `allow-scripts` beside it the frame would run that script as the renderer, `window.parent.electronAPI` included. So the preview runs no script at all, submits no form, opens no popup and cannot navigate the window. `buildPreviewDocument` puts a Content-Security-Policy in front of the server's markup that loads nothing from the network (images, fonts and media from `data:` only, stylesheets inline only), since a srcdoc document resolves relative URLs against the renderer's base URL and would otherwise send GETs wherever the body pointed, the engine's loopback port included; a page that leans on a CDN previews unstyled. Links are inert through `<base target="_top">`, which the sandbox refuses. The injected policy is the preview's only one (#1780): it lives in the document, where `sandbox=""` enforces it without `allow-same-origin`, and the frame carries no `csp` attribute. `preview-sandbox.test.tsx` holds the attribute and scans every `<iframe>` under `src/` for a sandbox without `allow-same-origin`
- `ResponseEvents.tsx` - the Events timeline (issue #574). It lived under `request-builder/components/ResponseViewer/` until a second surface needed it: a load run's sampled stream, whose events the engine parses back out of the stored body and serves on `GET /runs/:id/samples`. Three sources now feed one list - the live relay, a restored design trace, and a captured load sample - and the truncation disclosures (`eventsTruncated`, per-event `dataTruncated`) are stated once for all three. The rows are memoized and rendered through `useGrowingWindow`, since a stream runs to 100,000 events by default (issue #1158); a source whose list grows in place passes `listKey` so the window resets on a new stream rather than on every batch, and the two that arrive whole want the default. Each row shows `+<offset>` from the `sentAt` prop (the send) and `+<gap>` from the previous event, both derived from `receivedAt` through `elapsedBetween` (`utils.ts`, floored at 0) and drawn beside the wall-clock time (#3775); an event with no `receivedAt` - a load run's sampled capture - or a list with no `sentAt` shows no offset, and the first event has no gap. A **Rows / Text** switch (the `ToggleGroup` primitive) appears once the list carries any event `text` or a `streamText` is passed, and Text is its default: the joined reply, selectable, with a warning `Callout` per event the server named `error` (the first three; the rest are counted) beside the end-reason note. It reads the `streamText` prop over joining the items - the engine's string covers events past the stored cap - and says the text is partial in band when the list was cut and none came with it. It never parses `data` and builds no finish-reason callout: the path is declared and no provider is sniffed. Rows keeps the window and the offsets above.
- `LargeBodyNotice.tsx` - the info `Callout` ("Large response") for a pane that shows only the first `LARGE_BODY_BYTES` of a body: the Body tab's `ResponseBody` and the request builder's Raw tab (issue #3138). The wording lives here once; each caller supplies whether formatting is off (only the Body tab formats) and its own Download sentence, since only it knows whether a Download button is on screen
- `CapturedResponseNotice.tsx` - what a captured load-run response is *not*: truncated at `maxSampleBodyBytes`, dropped once the run's `maxSampleBytes` budget was spent, or binary and therefore stored by size and type. All three are invisible in the bytes - a truncated body looks malformed, a dropped one looks empty - so the difference is stated rather than left to be inferred
- `HeadersViewer.tsx` - the headers family, three variants in one file: the collapsible table, `CompactHeadersViewer` (same content on a sunken slab, for panes with no room for a table), and `ResponseHeadersPanel` (the Headers *tab* - request collapsed above response open, with the empty state `HeadersViewer` alone cannot give). The panel's request section lists the request as it was sent (issue #2464), taken from the engine's recorded raw request when it has one: `wire-headers.ts` reads the header block of `rawRequest` into `ResponseState.wireRequestHeaders`, every line in wire order, the transport's own (`Host`, `Accept`, `Content-Length`, the jar's `Cookie`) beside the author's and a repeated name as separate rows, so `HeadersViewer` takes a list of `[name, value]` lines as well as a map. It is derived once, in both response funnels, so a live send and a restored run list the same lines. With no recorded frame (a restored row, whose Raw tab fabricates one, and a failed send) the section lists `ResponseState.requestHeaderLines` (issue #2466): the request's own lines as sent, in order, a repeated name a row each in the spelling typed, which both funnels set through `sentHeaderLines` (`/execute`'s `requestHeaderLines`, the trace's `request.sentHeaderLines`; an empty list is an absent one). Only an answer that predates both shows the folded `requestHeaders`. The compact viewers keep reading `requestHeaders`. The response side renders the header lines as received (`headerLines`, issue #2460): a repeated name is a row each, in the server's case, and the Headers tab count counts them; with no lines the table is built from the folded map (`resolveHeaderLines`). A load-run sample and an inbox capture keep the map alone.
- `StatusCodeBadge.tsx` - the status chip
- `TestsChip.tsx` - what a step's assertions came to, as one line (issue #724). Two states and an absent third: a step that asserted nothing is given no tally and renders no chip, because `0 passed` reads as a result where the truth is that nothing was claimed. Here rather than in the step list because it summarises a *response*, and because the live half (the `step` event's two numbers) and the restored half (the stored list, tallied) must not word it two ways
- `ResponseStatusBar.tsx` - status chip + elapsed time + payload size (hover: `RESPONSE_SIZE_TIP`, "decoded body bytes", plus the compressed length when the `headers` prop shows a Content-Encoding, #2787). Beside the elapsed time, when the response carries `timing.engineMs`, a muted "in Vayu" figure: Vayu's own cost for the send (#2132), with `ENGINE_COST_TIP` (`utils.ts`) as its hover and the Timing tab's tip. Drawn only for a finite figure of zero or more; a stream, an auth failure and an older stored row show none. After it, when the response carries `timing.scriptMs` **and** `timing.wireMs` and the scripts took longer than the wire, an "in scripts" figure with `SCRIPT_TIME_TIP` as its hover (#3676): script time is outside `time` and outside Vayu's figure, so the bar draws it only when the user's code, not the network, is what made the send slow (the Timing tab always shows it); equal or shorter, or no `wireMs` to compare against, draws nothing. While `streaming.sentAt` is set, the time slot is an `ElapsedClock` that counts up from it on `TIMING.STREAM_CLOCK_TICK_MS` (#3775): a stream's `time` is held at 0 until the run settles, and the bar reverts to `time` the moment `streaming` is dropped
- `HttpVersionDowngradeNote.tsx` - the "HTTP/1.1, not HTTP/2" warning line, with its hover, for an exchange that asked for HTTP/2 and negotiated something older (#215). The status bar draws it from `httpVersionDowngraded`; the collection run's `ScenarioStepCard` draws the same component above its `UnifiedResponseViewer`, which has no status bar (#3262). Drawn only for a flagged response.
- `ResponseActions.tsx` - the copy/download pair. Given `rawBytes`, Download writes those exact bytes as a Blob under the response's Content-Type (`downloadBlob`, `lib/download-text-file.ts`) with an extension from that type, and Copy is disabled behind a `DisabledHint` for a body with no text. A text body is named the same way (`extensionForContentType`: `text/javascript` saves as `.js`, `application/problem+json` as `.json`), with `.txt` where that gives `bin`, so there is no per-caller extension prop (#3140). A failed save is a `Couldn't save <file> - <reason>` toast naming the file the user chose when the dialog got that far (#3607); a cancelled save dialog says nothing (#3246)
- `tab-trigger.ts` - `RESPONSE_TAB_TRIGGER`, the underline-on-active class
- `phase-tips.ts` - `PHASE_TIPS`, the five per-phase timing tooltips (DNS -> Connect -> TLS -> TTFB -> Download), shared so every renderer of those numbers reads one string
- `timing-phases.ts` - `TIMING_PHASES`, the same five phases as one descriptor list (label, hue, tooltip, and the trace/average field each reads), plus the `phasesFromTrace` / `phasesFromAverages` selectors
- `TimingPhaseTiles.tsx` - the dense tile grid (one labelled box per phase), rendered inside the sampled-exchange shell; an optional `scriptMs` adds a "Scripts" tile after the phases when reported (`isReportedMs`: `0` draws, absent does not, #3739)
- `ScriptRequestRow.tsx` - one `pm.sendRequest` a script made (#3633): a summary row (`MethodBadge`, URL, `StatusCodeBadge` with `ERR` for a call that never connected, the error code, total time) that expands into the request's headers (the sent lines when recorded) and body, the redirect hops, the response's headers and body, and `TimingPhaseTiles`. Composed from `CompactHeadersViewer`, `ResponseBody` and the tiles rather than `UnifiedResponseViewer`, which lists no sent lines and pins its panels at 500px. The response node is read through `responseHeadFromTrace` (`restore-response.ts`), so a base64 body decodes as the main exchange's does. Drawn by the Console tab (`console/ScriptSection.tsx`) and under a lifecycle row in `ScriptLifecycleSummary`. Values render as the engine masked them; the app adds no masking
- `SampledExchange.tsx` - the sampled-exchange shell: summary row, expansion, error block and timing tiles

> **One shell for a sample row.** The dashboard's live sample list and the
> history detail's stored one showed the same thing - a sampled HTTP exchange
> you can expand - and were two components (the dashboard's went with #2220,
> when it began rendering History's report). #60 gave them the same per-concern
> primitives, which moved the drift up into the shells rather than removing it:
> each still owned its summary row, its expansion chrome and its section order,
> so a spacing or empty-state fix to one did not reach the other. By the time
> they were merged the rows differed in almost everything that is not data - one
> chevron and one hand-drawn CSS triangle, two different icon sets, and a
> slow-request state on only one side.
>
> `SampledExchange` is **presentational over already-shaped data**: a status
> code, a latency, a pre-resolved phase list. Expansion stays the parent's
> state; the history detail holds a single open row. What the caller adds
> arrives as slots (`details` before the timing tiles, `children` after, and
> `actions` beside the summary, outside its button), not as
> boolean flags; the caller keeps its own chrome and its own timestamp
> formatting, because a stored row dating a run wants the day where a row
> placing a sample inside a seconds-old run would want milliseconds.
>
> An optional `scriptMs` (a step's or a Send's script time, #3739) draws a
> "Scripts" tile in the timing breakdown, and opens the section even with no
> phases; load-run samples pass none.
>
> Its icon reads **error** for a transport `error` or any status outside
> 200-399 (`isErrorStatus` in `constants/http-status.ts`, the renderer's copy of
> the engine's `is_success_status`, #2124), so a 404 or a 500 does not wear the
> success tick; a caller that knows better passes `state`.
>
> **The summary row is a grid, so a list's rows line up** (#3495). The button
> is `grid` over fixed tracks (chevron, icon, a `3.5rem` label, one flexible
> lead, then from `@3xl` a `12rem` status, a `4.5rem` latency and the time), and
> the status, latency and time sit in a wrapping group that dissolves
> (`@3xl:contents`) into those tracks; below `@3xl` they wrap as one line under
> the name. The thresholds are container variants against the row's own
> `@container` root, not `sm:`, because the run pane is narrower than the window
> by the context bar. The lead holds the caller's `title` in a `min-w-0` box (it
> is a node of the caller's own shape) and the error's first clause as a
> `TruncatedText`, so a cut error still has its full text on hover; the full
> message is in the expanded block as before.
>
> Guarded by `sampled-exchange-adoption.test.tsx` (the shell is replaced with a
> sentinel, so a view that hand-rolls a row fails) and
> `SampledExchange.test.tsx` (the shell's own behaviour).

> **One list, four renderers.** The five network phases are drawn by the
> request-builder's `ResponseTimingTab` (timeline + legend), the history
> Performance tab's `PhaseAveragesCard`, the dashboard's
> `charts/TimingWaterfall`, and the history `SampleRequestCard`. They share
> one list: a copy per renderer means adding a phase requires finding every
> renderer, with nothing pointing you at the others, and copies drift. A waterfall
> that paints TTFB with `--primary` - an accent-tracking token the design system
> forbids for a chart series, and the very bug `ResponseTimingTab`'s header
> comment describes fixing in its own copy - and carries private tooltip strings
> is what `phase-tips.ts` exists to replace.
>
> Add a phase to `TIMING_PHASES` and every renderer picks it up.
> `timing-phases.test.tsx` guards that by mocking in a sixth phase and asking
> each renderer to show it, so a call site that goes back to a local array fails.

> **Two shells, shared parts.** The request builder has its own richer
> `components/ResponseViewer/` (console output, test results, cookies, timing,
> raw request/response, client-error view) fed from live context;
> `UnifiedResponseViewer` shows two tabs from a stored run - three when
> the sample streamed. They are **not** merged, and should not be: seven tabs against three,
> live context against props, and three different empty/loading/error states
> would become a component driven by flags.
>
> What *was* duplicated is extracted above. Before this, the status bar existed
> twice class-for-class, the copy/download pair twice (already drifted three
> ways), the Headers tab twice, and the tab-trigger string ten times - which is
> why the same invisible-divider fix had to be applied to both, and why
> `StatusCodeBadge`'s `status === 0` branch was once lost from one copy and
> rendered a literal `0`.
>
> Adding a genuinely shared piece: put it here and consume it from both. Adding
> something only one shell needs: leave it in that shell.

## Shared Auth Fields (`components/shared/AuthFields/`)

The one editor for a request's or collection's **concrete** auth, consumed by the
request builder's `AuthPanel` and the collection `AuthTab`. Both hosts hold the
domain `RequestAuth` shape, so the component reads `mode` and `in` directly -
there is no editor-local vocabulary and nothing to translate at the boundary.

- `AuthFields.tsx` - the None / Bearer / Basic / API Key field groups, and
  oauth2 delegated to [`OAuth2Form`](#shared-oauth-20-form-componentssharedoauth2form). Takes an **injected
  `TextInput`** (the same contract `OAuth2Form` defines) so the builder supplies
  a variable-aware token editor while the collection editor takes the default
  plain input, which accents `{{var}}`. Each field is a
  `components/shared/LabelledField.tsx`, which links its `<Label>` to the control by
  a `useId` and hands the input that `id` and the label's text: an input that names
  itself (the builder's `VariableInput` falls back to its placeholder) passes the text
  as its `aria-label`, which outranks the `<label for>` (#3498). `noAuthDescription` is host-supplied: a
  request sends nothing, a collection hands nothing down, and those are different
  statements under one empty state. An API key sent in a **header** carries a
  one-sentence note that a redirect takes the key to whichever host it leads to
  and that turning off Follow redirects on the request prevents it (issue
  #2476): the engine drops `Authorization` and `Cookie` across a scheme, host or
  port change and nothing else, so the API key header is the exception, kept on
  purpose (#2949; the Cookies tab flags an https-to-http hop). A query
  key and the `Authorization` modes do not get it, and
  `AuthFields.test.tsx` holds all three branches. `deferredNames` is forwarded to
  `OAuth2Form` and on to the token row (#2742); `AuthPanel` computes it, the
  collection `AuthTab` has no request to compose and passes none.
- `types.ts` - `AuthFieldsProps`, `AuthTextInput`, `EditableAuth`.

What stays with each host: the mode picker (only the request offers `inherit`),
the collection's per-mode inheritance hints, and the "stored but not editable"
warning for `digest`/`aws`/`ntlm`/`hawk`/`oauth1`/`edgegrid`/`jwt` - modes the engine cannot resolve, which both
editors surface rather than collapse to "none". The warning says Vayu does not send
the type and the request goes out without auth; the context bar's request and collection
Auth sections and the inherit banner say the same through `isEngineExecutableAuthMode`
(`constants/auth-modes.ts`) instead of "Sending <mode>" or "send this". `AuthFields` renders nothing for
them and carries their config through untouched.

Mode names and the editable list live in `constants/auth-modes.ts`
(`AUTH_MODE_LABELS`, `EDITABLE_AUTH_MODES`), which every auth surface reads -
including `AuthInheritBanner`. Four places naming the modes independently
would drift; `auth-modes.test.ts` and `AuthFields/auth-editor-parity.test.tsx`
hold that line, the latter by rendering both hosts and comparing what they show.

## Shared OAuth 2.0 Form (`components/shared/OAuth2Form/`)

The reusable OAuth 2.0 auth editor, consumed by the request builder's `AuthPanel` (and structured to be host-agnostic). A barreled module like `response-viewer/` (its `index.ts` exports the public surface):

- `OAuth2Form.tsx` - grant-type select (Client Credentials / Password / Authorization Code + PKCE / JWT bearer), per-grant fields (for Authorization Code, `DiscoveryFields.tsx` first: see below), an advanced section (placement, prefix, audience/resource, credentials id, the extra request parameter tables, and the lifetime a token that states none is kept for, `fallbackExpiresIn`, for every grant), and the token status row. Takes an **injected `TextInput`** so the host supplies a variable-aware input; secret fields render the masked `SecretInput` instead.
- `TokenStatusRow.tsx` - cached-token status (masked token + expiry countdown, with a reveal toggle) and Get/Refresh/Clear actions. `token-phase.ts` (`tokenPhase(status, now)`) decides once whether the token is current or lapsed and hands the dot, the action's label (Get token / Renew / Refresh) and glyph, and the expiry text to the row, so they cannot disagree: a token has lapsed when the engine's `expired` flag says so **or** its `expiresAt` has passed, and `useNow` (`hooks/useNow.ts`) re-renders the row at that instant instead of waiting for the 30s status poll (#3354). With no token to show, the summary says which of five things is true: a field is missing, the config awaits discovery ("Not signed in - Get token discovers the server's endpoints"; #3766), the check is pending ("Checking for a cached token…"), the check failed ("Couldn't check for a cached token", in the error colour; the last answer stays on screen when only a refetch failed), or the engine answered and nothing is cached ("No token cached"). Drives interactive sign-in via `useOAuth2SignIn` for the Authorization Code grant, and for a discovered config hands what the sign-in filled to the host's `onDiscovered`, which the form writes into the stored config. A host that passes no `onDiscovered` (the context bar) cannot sign in a config still awaiting discovery: Get token is disabled and the row says to get a token from the Auth tab, because the token would land under a key the stored config never comes to name. The sign-in belongs to the config, not the row (`stores/oauth-signin-store.ts`, keyed by cache key, or `discover:<url>` for a config awaiting discovery): two rows for one config show one pending sign-in, the pending row offers **Cancel sign-in** (an X before the token action, which stays the rail's last child), and the last row for a config to unmount aborts its sign-in. A cancelled or abandoned sign-in raises no toast and no system notification; the browser tab or embedded window it opened stays for the user to close. The row always renders: an incomplete config **disables** the token action and names the fields still missing (by their on-screen labels) rather than hiding the affordance. Presence only - the engine owns URL validity, and its 400 surfaces as a toast **relabelled** through `constants/oauth2-fields.ts`, so `accessTokenUrl must be an http(s) URL` reads as *Access Token URL*. The same registry supplies the form's labels for those fields, and the `AUTH_FAILED` toasts in the request builder and `DesignRunView` relabel the identical engine string. Given `deferredNames` (the names in the as-written config that a pre-request script may change, computed by the host with `useOAuth2DeferredNames` from the engine's `deferredVariables`; #2742) it reports no token state at all: a Send resolves the config after the script, so the token cached for the stored values may not be the one it uses. It reads no cache entry and shows no masked token, expiry, Show or "No token cached" - only a sentence ("`{{clientId}}` may be changed by a pre-request script, so the token this request sends is fetched at send, after the script. Get token and Clear act on the stored settings.") beside the same Get token and Clear actions, which stay live because for an Authorization Code grant this row is the only place to sign in. The names are a prop, never a query inside the row, because it is shared by the builder's Auth tab, the context bar and the collection editor. Internal to the module.
- `DiscoveryFields.tsx` - the Authorization Code grant's "Discover from the server URL" switch and its **Server URL** field (`discoverUrl`, #3766). The sign-in discovers the MCP server's authorization server and fills what the config leaves blank: both endpoints, Resource, Scope and, with no Client ID typed, a registered client. What it wrote is named in `discoveredFields`; the form shows each of those members read-only (a plain `Input readOnly`, like a picked key file) and every other member editable, where a typed value wins over discovery and a blank one's placeholder says it is found at sign-in. A "Found by discovery: ..." line beside **Discover again** lists them; the button clears them (`clearDiscovered`), so the next sign-in finds the current endpoints and registers a fresh client, which is the way back from a registered client the server stops accepting (it was registered for one loopback port). Turning the switch off keeps the values as ordinary editable ones. The logic is `services/oauth/discovery.ts`; the labels are `DISCOVER_URL_LABEL` and `DISCOVERED_FIELD_LABELS` in `constants/oauth2-fields.ts`, outside the engine-message registry because no engine message names those members.
- `useOAuth2SignIn.ts` - the interactive sign-in for one config, shared by the token row and the response pane's step-up callout: it acquires the sign-in key while mounted, runs `runInteractiveAuthorization`, invalidates the token status under the key the engine reports, toasts and posts the signed-in notification, and then hands the result to its caller's `onSignedIn` only while the caller still shows a config with the key the sign-in ran under (a sign-in lasts minutes in a browser; by then the surface may show another request). The callback runs after the sign-in is ended, because a write can change the config's key.
- `JwtBearerFields.tsx` - what only the JWT bearer grant (RFC 7523, #3632) shows: subject, assertion audience, the signing key, algorithm (RS256 or ES256), key ID, assertion lifetime (`SecondsInput.tsx`, placeholder 180) and an "Extra claims" table, which is a `ParamRowsEditor` without `sendAs`. Client ID stays the form's own field and is the assertion's `iss`; the client secret, username and password are not shown, and choosing the grant drops a stored `clientSecret` so a value nothing displays is not sent as client authentication. **The key is one control with two sources**, a `{{variable}}` (`privateKey`) or a picked file (`privateKeyFile`), and choosing one clears the other. The variable is never resolved in the renderer. What is typed is a local draft: it reaches the config only when it is empty or exactly one `{{name}}`, because every config change autosaves and the engine refuses any other `privateKey`; anything else shows "Enter the secret variable as {{name}}" and is dropped on blur. A PEM typed or pasted into the field (text containing `-----BEGIN`) is refused inline and never reaches the config, since a config is saved, exported and sent; the sentence says to use a secret variable or a file. The file comes from `useFilePick` (`shared/file-pick.ts`), whose path lookup is also what records the engine's grant for the pick, and with no path (outside Electron) the form claims no file. A hint warns when the variable it names is in scope and not marked secret. `missing-fields.ts` is the row's list of what a token request still needs (for this grant: subject, assertion audience and one key source, not the authorization URL).
- `ParamRowsEditor.tsx` - one of the config's extra request parameter lists (`authorizationParams` for the authorization code grant, `tokenParams`, `refreshParams`; issue #2536) as a [`KeyValueEditor`](shared-key-value-editor.md#shared-keyvalue-editor-componentssharedkeyvalueeditor). It takes the host's `variables` (forwarded through `AuthFields`) so a row has the `{{` autocomplete and the resolved peek. The token and refresh mounts pass `sendAs`, which gives every row a "Send in" select (Body, URL, Header; issue #2571) through `KeyValueEditor`'s `rowExtra` slot; the authorization mount does not, since every row of that list rides the sign-in URL's query. Body is an absent `sendAs`, so choosing it removes the member and a config that never used the select is unchanged, and an imported `url` or `header` row shows its place and keeps it through every other edit. The trailing spare row has no select (it is dropped while blank, so a choice made there would be lost), and an unticked row's select is off like its fields. The select is named per row (`Send audience in`), and its renderer is a `useCallback` because the row it reaches is `memo`-wrapped. An emptied list is removed from the config, not stored as `[]`. `resolveOAuth2Config` (`resolve-config.ts`) resolves every row's key and value under a per-row `stableConfigField` entry, so the status row's cache key (which reads these rows) and a Get Token see the same text.
- `resolve-config.ts` - `resolveOAuth2Config(value, resolveString, resolveKey)`, the form's `resolvedConfig`: every string field resolved under a per-field `stableConfigField` entry keyed by the host's `resolveKey`, so a `{{$guid}}` answers the same after the Auth tab remounts. A surface outside the form that acts on the same config's token resolves it here with the same key, so it posts what the form shows.
- `types.ts` - `OAuth2FormProps`, `OAuth2TextInput`. `collectionId` is forwarded from `AuthFields` to the token row: the request's collection in the Auth tab and the context bar, the collection itself in its own auth editor.

Config resolution (`{{variables}}`), the token cache key (`services/oauth/cache-key.ts`, byte-identical to the engine), and the token queries (`queries/oauth.ts`) sit behind it.
