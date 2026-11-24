---
description: >-
  What the QuickJS sandbox gives a script: isolation between scripts, what a script can compute, timers and top-level await.
---

# The sandbox

## Isolation between scripts

Every script runs in a QuickJS context built for it and discarded after it.
Globals it leaves behind (`globalThis.x = 1`, an implicit `x = 1`), a replaced `pm`, `pm.test` or `console.log`, and patches to `String.prototype`, `Array.prototype` or `Object.prototype` are gone before the next script on the thread starts, including one from another collection.
Only the QuickJS runtime (memory limit, deadline, class registrations) is reused.
A promise job the script queued (a `.then` callback, the rest of an `async` function after an `await`) runs before the script ends, inside its deadline; one still queued when the deadline or the job cap stops that drain is discarded with the runtime, never run, and the next script starts on a new one.
A [timer](#timers-settimeout-and-setinterval) still queued then is dropped unrun too; the queue is the engine's to free, so it costs the runtime nothing.
State that should carry from one script to the next belongs in a variable scope (`pm.environment`, `pm.collectionVariables`, `pm.globals`).

One thing is shared on purpose: `Math.random` draws from a generator that lives on the thread, seeded once from libsodium, not from one the context owns.
QuickJS seeds a context's own generator from the microsecond clock, so two workers starting a script in the same microsecond would draw the same numbers (#3460); with a per-thread generator the contexts of one thread continue a single sequence and two threads never share one.
It is the same xorshift64* generator QuickJS runs, a fast PRNG and not a CSPRNG, so a script that needs unpredictable values uses `require('uuid')` rather than `Math.random`.

## What a script can compute

The sandbox is QuickJS plus `pm`, `console`, the two base64 globals, the four timer functions, Postman's legacy globals (`postman`, `tests`, `responseBody`, ...) and nine bundled libraries, `crypto-js`, `uuid`, `lodash`, `moment`, `csv-parse/lib/sync`, `xml2js`, `chai`, `ajv` and `tv4` ([below](require-shelf.md#the-require-shelf)).
Available: `JSON`, `Date`, `Math`, `RegExp`, `String`, `Array`, `Object`, `Number`, `Uint8Array`, `Promise`, `BigInt`, `encodeURIComponent`, `parseInt` and the rest of the ES2020 built-ins, plus:

| Name | Shape |
| ---- | ----- |
| `pm.crypto.sha256(data, encoding?)` | SHA-256; `data` is a string (UTF-8) or `Uint8Array` |
| `pm.crypto.hmacSha256(key, data, encoding?)` | HMAC-SHA256; key and data take the same types |
| `pm.sendRequest(urlOrOptions, callback?)` | Send an auxiliary request, synchronously; a promise without the callback - see [above](send-request.md#sending-a-request-from-a-script-pmsendrequest) |
| `btoa(binaryString)` | base64-encode one byte per code unit |
| `atob(base64)` | decode to a binary string; throws on invalid base64 |
| `setTimeout(fn, delay?, ...args)` / `setInterval(...)` | queue `fn`, run before the script ends - see [Timers](#timers-settimeout-and-setinterval) |
| `clearTimeout(id)` / `clearInterval(id)` | cancel one; the two share their ids |
| `require(name)` | The [shelf](require-shelf.md#the-require-shelf): `require('crypto-js')`, `require('uuid')`, `require('lodash')`, `require('moment')`, `require('csv-parse/lib/sync')`, `require('xml2js')`, `require('chai')`, `require('ajv')` and `require('tv4')` answer the library, any other name throws |
| `CryptoJS` | The same `crypto-js` module as a global, loaded on first read |
| `_` | The same `lodash` module as a global, loaded on first read |
| `xml2Json(xml)` | Postman's synchronous XML parse over the shelf's `xml2js`, loaded on first read - see [`xml2js`](require-shelf.md#xml2js) |
| `postman.setEnvironmentVariable(name, value)` and ten more | Postman's pre-`pm.*` helper methods, each an alias of a `pm.*` method - see [The legacy `postman` object](legacy-and-visualizer.md#the-legacy-postman-object) |
| `tests`, `responseBody`, `responseCode`, `responseHeaders`, `responseCookies`, `responseTime`, `environment`, `globals`, `data`, `iteration`, `request` | Postman's pre-`pm.*` values, read off `pm` when the script starts - see [Postman's legacy globals](legacy-and-visualizer.md#postmans-legacy-globals) |

`encoding` is `'hex'` (the default), `'base64'`, `'base64url'` or `'bytes'`; `'bytes'` returns a `Uint8Array`, and any other value throws rather than silently falling back to hex.

**Not** available: `crypto` / `crypto.subtle`, `TextEncoder`, `URL`, `URLSearchParams`, `fetch`, `Intl` (the `toLocale*` methods ignore their locale and options, see [Limitations](limitations.md#limitations)), and any module other than the shelf's.
The practical consequences: no general URL constructor -
the request's own URL is already parsed for you,
see [URL parts](request-mutation.md#url-parts-pmrequesturl) - no asymmetric algorithm and no cipher (the digests are `pm.crypto.sha256` and the [`crypto-js` hashers](require-shelf.md#the-require-shelf)), and no host I/O:
`Promise`, `async`/`await` (a [top-level `await`](#top-level-await) included) and the timers run, on queues drained before the script ends, but nothing settles a promise after it has.
Signing a request with a private key is the OAuth 2.0 JWT bearer grant's job, which the engine does itself, not the sandbox's; `pm.crypto` does not gain RS256.
There is no `fetch`, but there **is** [`pm.sendRequest`](send-request.md#sending-a-request-from-a-script-pmsendrequest), which is synchronous and bounded; without a callback it returns a promise that is already settled, not one waiting on a transfer in flight.

Of the libraries Postman bundles, `CryptoJS`, `_` (lodash), `uuid`, `moment`, `csv-parse/lib/sync`, `xml2js` with its `xml2Json` global, `chai`, `ajv` and `tv4` run (`uuid`, `moment`, `csv-parse/lib/sync`, `chai` and `ajv` have no global, they are `require` only, as in Postman; `tv4` is a global and a module, one object).
The others (`cheerio`, `Backbone`) are absent.
The editor declares each as unusable, so a use is underlined and the hover names the replacement; [the compatibility page](../../app/pm-api-compatibility.md#not-yet-supported) lists them.

## Timers (`setTimeout` and `setInterval`)

`setTimeout(fn, delay, ...args)` and `setInterval(fn, delay, ...args)` queue `fn`, return an id, and `clearTimeout(id)` / `clearInterval(id)` cancel it (the two share their ids, so either cancels either).
Every timer runs **before the script ends**: the request is not sent, and a test script's results are not read, until the queue is empty (#2577).
That is Postman's rule too - its sandbox waits for every timer before it reports.

```javascript
setTimeout(function (label) {
    pm.test(label, function () {
        pm.expect(pm.response.code).to.equal(200);
    });
}, 100, "status, checked from a timer");
```

**The delay orders the callbacks; it is not waited out.**
The queue runs on a virtual clock: firing a timer moves the clock to its due time, so callbacks run in due order (a tie to the one queued first) and the promise jobs each callback queues run before the next timer, as on an event loop.
Nothing sleeps: `setTimeout(fn, 60000)` runs `fn` as soon as the work ahead of it has, and `Date.now()` does not advance by the delay.
A delay that is not a number from 1 to 2147483647 counts as 1, Node's rule.
**A `setTimeout` written as a sleep therefore does not delay the request** - in Postman it would, inside the script's deadline; in Vayu that is a [Think time element](.././elements.md) (`timer.think`), which waits without holding a script open.

What runs in a timer is a script like any other.
`pm.test` inside one records a test, a promise a timer resolves settles before the script ends, and a callback that throws is the script's error while the rest of the queue still runs - the rule a throw in the script body follows.
`fn` must be a function: a string is refused with a `TypeError` rather than evaluated.
One script may hold at most 10,000 pending timers (`MAX_PENDING_TIMERS`); the queue lives outside the script's memory limit, so this is what bounds it.

**An interval nothing clears ends the script with an error.**
Clear it from its own callback when it is done.
Otherwise it runs until the deadline stops it, `Script execution timed out after <n>ms`.
(Only an engine run with no deadline at all, which no setting produces, falls to the cap on asynchronous work in [Limitations](limitations.md#limitations).)

## Top-level `await`

A script runs as the body of an async function, the wrapper Postman puts around every script (#2577), so `await` works at the top level and a top-level `return` still ends the script early:

```javascript
const code = await Promise.resolve(pm.response.code);
if (code !== 200) return;
pm.test('the lines after an await run', function () {
    pm.expect(pm.response.json()).to.be.an('object');
});
```

The lines after an `await` run when the queues drain, inside the script's deadline, so a body awaiting a [timer](#timers-settimeout-and-setinterval)'s promise resumes when that timer fires on the virtual clock, after the timers due before it.
A throw, before the first `await` or after one, is the script's error and reads as the throw itself (`Error: x`), never as `Unhandled promise rejection`; a timer callback's throw and the body's are reported in the order they happened.
A body still awaiting when both queues are empty is waiting on a promise nothing can settle any more, so its remaining lines never run, and the script ends with `The script did not finish: it was still awaiting a promise that never settled`.
The wrapper adds no line, so a line number in a stack is the script's own.
