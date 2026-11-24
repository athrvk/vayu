---
description: >-
  `pm.cookies` and the cookie jar: reading cookies and writing to the jar.
---

# The cookie jar (`pm.cookies`)

```javascript
pm.cookies.get('session');      // value, or undefined
pm.cookies.has('session');      // boolean
pm.cookies.toObject();          // { session: 'abc' }
pm.cookies.each(function (cookie) { console.log(cookie.name); });
pm.cookies.all();               // array of cookie objects
pm.cookies.count();             // number
```

`pm.cookies` is what the engine is holding *for this request's URL* - matched on domain, path, `Secure` and expiry, exactly as it will be sent.
A `Secure` cookie needs `https://`, except for `localhost`, `127.0.0.1` and `::1`: libcurl treats those as trustworthy and sends the cookie over `http://` too, so the jar reads (`get`, `getAll`, ...) report it there as well.
It is what makes "log in once, reuse the session" work: a `Set-Cookie` on one request is carried to the next one automatically, with no header to set by hand.

**`each`, `all()` and `count()`** are Postman's CookieList reads, over the same matched set `get`/`has`/`toObject` answer over - what this request's URL would carry.
Each call reads the jar afresh, so a `jar().set` earlier in the script is visible by the time one of these runs.
`each(fn, context?)` calls `fn` once per cookie with the whole cookie object (below), `context` becoming the iterator's `this`; a throw from `fn` - a failed `pm.expect` inside it, most likely - ends the walk and is the script's error rather than being swallowed.
`all()` returns an array of cookie objects, `count()` the number of them.

A cookie object - what `each`, `all()`, `jar().getAll()` (below) and `jar().set`'s callback all hand back - carries:

| Field | Value |
|-------|-------|
| `name`, `key` | the cookie's name, under both spellings. Postman's `Cookie` calls it `key`; both are present, same value |
| `value` | the cookie's value |
| `domain`, `path` | where it is scoped |
| `secure`, `httpOnly` | booleans |
| `hostOnly` | `true` when the cookie answers for that host only, `false` when it answers for subdomains too |
| `session` | `true` for a session cookie |
| `expires` | a `Date`, or `null` for a session cookie |

Postman's `maxAge` and its unmodelled `extensions` are deliberately absent: the jar does not keep them, and a field with nothing behind it is a value a script would read and act on.

- **One jar per environment**, plus one for requests sent with no environment selected.
  A staging session therefore cannot ride along on a production call even when both point at the same host - which cookies alone would not prevent, since they ignore the port and the scheme.
- **In memory only**, for as long as the engine runs.
  Nothing is written to disk: a stored jar is credential-grade material.
  Settings → General → Cookies shows every jar and clears them.
- **`pm.sendRequest` shares the jar** of the request it runs inside.
  A pre-request script that logs in through it leaves the session where the real request will find it.
- **Load runs mostly have no jar.**
  The jar is deliberately off the load path: sharing one across the event loop's workers would put a lock on the hot path.
  One exception (issue #1501): a scenario load run's own inline `script.*` element reads that one virtual user's own cookies through the flat surface above - the same per-user state the run already carries step to step outside any script (`docs/engine/architecture.md`'s Cookie Jar section, "Not on the load path"), with no lock, because that user's own completion is the only reader.
  A single-request run (no scenario, no virtual user) and a scenario step's deferred replay (a recorded response, not the user that fetched it) still throw there, each naming its own reason rather than the one sentence above.
- **Writing goes through `jar()`**, below.
  There is deliberately no flat `pm.cookies.set(name, value)`: a written cookie needs a URL to take its domain and path from, which is exactly why Postman's write half hangs off the jar object.

The jar is libcurl's own cookie engine underneath: matching, expiry and replacement are its rules, not a second implementation of RFC 6265.

`SameSite` is ignored, on purpose: a script is not a browsing context, so there is no cross-site request to restrict.
A jar cookie is sent whatever its `SameSite` value.

## Writing to the jar (`pm.cookies.jar()`)

```javascript
const jar = pm.cookies.jar();

jar.set(pm.request.url, { name: 'session', value: token });
jar.set(pm.request.url, 'session', token);            // the same, flat
jar.get('https://api.example.com/', 'session');        // value, or undefined
jar.getAll('https://api.example.com/');                 // every cookie that URL would carry
jar.unset('https://api.example.com/', 'session');
jar.clear('https://api.example.com/');                 // that URL's cookies
jar.clear();                                           // this environment's jar
```

Postman's jar object, whole - **`getAll`** is new, Postman's "dump the session" read: every cookie a request to that URL would carry, as an array, whole.
It is exactly what `get(url, name)` matches, without a name to narrow it - the same domain/path/`Secure`/expiry rules, the same per-environment jar, and a cookie this script has already staged with `set` is included - though only for a URL inside the request's site (see [Reads are limited to the request's site](#reads-are-limited-to-the-requests-site)).
Every method is **URL-scoped** - it takes the URL the cookie belongs to rather than assuming this request's (`clear`'s URL is optional; see below) - and each accepts an optional trailing callback, invoked inline the way [`pm.sendRequest`](send-request.md#sending-a-request-from-a-script-pmsendrequest)'s is, since the work has already happened by the time it is called.
What the callback carries, and what the call itself returns, is what that call did - there is no longer one shape for all five:

| Method | Callback / return |
|--------|--------------------|
| `get(url, name)` | the value, or `undefined` |
| `getAll(url)` | every matching cookie, as an array of cookie objects |
| `set(url, cookie)` | the **stored** cookie object - the one thing this call knows and the script does not, since it carries the domain and path derived from the URL where `cookie` left them out |
| `unset(url, name)` | the removed name |
| `clear(url?)` | `undefined` - there is nothing left to describe |

The cookie object needs `name` and `value`; everything else is optional and defaults from the URL:

| Field | Default |
|-------|---------|
| `domain` | the URL's host, host-only. A leading dot (`.example.com`) means subdomains too |
| `path` | RFC 6265 default-path - the URL's path with its last segment removed, so `/v1/orders/42` gives `/v1/orders` |
| `secure`, `httpOnly` | `false` |
| `expires` | `0`, a session cookie. Otherwise a `Date`, a date string, or a whole number of seconds since the epoch |

**`expires` takes three spellings**, matching Postman: a `Date`; a date string - anything JavaScript's own `Date.parse` accepts, an ISO 8601 or an HTTP date; or a whole number of seconds since the epoch, `0` still meaning a session cookie.
The Date and the string are read by asking QuickJS's own `Date` (`getTime` and `Date.parse`) rather than a date parser written into the engine, so the answer here is the one the same script's own `new Date(s)` would give.
Because a stored cookie reads back with `expires` as a `Date` (above), and `set` now takes a `Date`, a cookie can be read and written back with nothing to convert.

Anything else is refused with an error rather than guessed at: a non-string `value`, a `secure: "yes"`, a field carrying a tab or newline (the separators of the format the jar stores), or a URL that cannot be parsed.
`expires` has its own refusals, loud ones: an Invalid Date, a string `Date.parse` cannot read, a **fractional** number of seconds - `date.getTime() / 1000` without the floor, which the message names both cures for (pass the `Date` itself, or keep the `Math.floor`) - a value before the epoch, and one further in the future than the jar can store.
A cookie stored under the wrong domain reads as "the session did not stick" three requests later, which is a much worse afternoon than a thrown error.

**A written cookie is matched by the same rules a received one is.**
Setting it for one host does not send it to another, `/admin` does not reach `/`, and the jar's per-environment isolation holds - the write half is not a way around the matching the read half respects.
Nor is it a way around the site limit: a write is held to the request's site and the hosts the script called, like a read (see [Writes are limited the same way](#writes-are-limited-the-same-way)).

**When the write takes effect.**
A write is *staged*, not applied where it is made, and the next transfer of that execution carries it:

- A `set` in a **pre-request script** rides the request it was made before, and that request's own cookie capture is what writes it into the jar, as one of that transfer's own changes.
  That is the reason for the ordering: a capture folds back only what its transfer changed against what it was seeded with, so a write dropped into the jar beside an in-flight request would be undone by it.
- A `set` followed by **`pm.sendRequest`** is carried by that auxiliary request.
  A `set` *inside* a `sendRequest` callback is a sequential write - `pm.sendRequest` is synchronous, so the callback runs after its transfer finished and the write lands on the next one.
- A `set` in a **post-request script** has no transfer left to ride, so it is applied to the jar when the script ends.

`unset` and `clear` are staged by the same rule and on the same queue - the bullets say `set` because it is the one that reads as immediate, not because the other two are.
So `jar.clear(url)` followed by `jar.getAll(url)` in one script sees the clear, because a read is answered over the staged writes as well as the jar; the stored jar itself is not emptied until that execution's next transfer carries the write.

**`clear` has two forms.**
`clear(url)` is Postman's: it removes every cookie a request to that URL would have carried - `unset` with no name to narrow it, and the same matching, so a cookie stored for another host or under `/admin` when you cleared `/` is left alone.
`clear()` with no URL empties **this environment's jar and no other**.
Nothing is on disk either way, so the cost is a re-login; other environments, and the no-environment jar, are untouched.
There is no confirmation gate for scripts - "reset my session" is a legitimate thing for a script to want, and Settings → General → Cookies shows the result.

A URL the engine cannot parse is **refused** rather than cleared as a wipe that happens to match nothing: `clear` is destructive, so "cleared no cookies" and "that was not a URL" must not read the same to the script.
Pass no argument at all for the whole-jar form.

Load runs have no jar for writes; `jar()` and every method on it throw there under every load-run script, including a scenario's inline ones - only the flat reads above have the one per-user exception described above.

### Reads are limited to the request's site

`get` and `getAll` answer only for a URL whose host is the request's own site or one this script has addressed through `pm.sendRequest`.
The jar holds the sessions of every host the environment has talked to, so without the limit a script - an imported collection's, say - could name any host and read its session cookie out.

"The same site" is RFC 6265's domain-match read in both directions: the hosts are equal, or one is a dot-boundary subdomain of the other, ignoring case and a trailing dot.
For a request to `www.example.com`, `www.example.com` and `example.com` are in scope and so is `shop.www.example.com`; `api.example.com` (a sibling), `example.org` and `evilexample.com` are not.
An IP address is in scope only as itself.
A non-ASCII host is compared as its punycode name, the one the jar keys on.

**The request's site is its URL as the variables resolve it at the call.**
A request a pre-request script runs before still holds its `{{name}}`s in that script (#2521), so its host is read the way `pm.variables.replaceIn` would read the URL at that moment: a `{{host}}` the environment stores, or one the script set a line earlier, names the site, and a write after the script moves `host` is held to the new one.
`pm.cookies.get` and its siblings match the same resolved URL.

A host the script has called with `pm.sendRequest` joins the allowed set from the moment of the call, whether or not the transfer succeeded, so "log in through `pm.sendRequest`, then read the session it set" works.
The set lasts one execution of one script.

A read outside the allowed set does not throw.
`get` answers `undefined` and `getAll` answers `[]`, through the callback as well, and the script's console gets one warning naming the host (never the full URL, which may carry a secret):

```
pm.cookies.jar().get read nothing for b.example: a jar read is limited to the request's own site (a.example) and to hosts this script has called through pm.sendRequest. See docs/engine/scripting.md.
```

**A redirect target is not seen.**
Only the request's URL and the URLs given to `pm.sendRequest` are compared.
A request to `a.example` that a server redirects to `b.example` does not put `b.example` in scope, so a script cannot read the redirect's cookies unless it called that host itself.

### Writes are limited the same way

`set`, `unset` and `clear(url)` are held to the same allowed set as reads: the request's own site plus the hosts this script has addressed through `pm.sendRequest`, compared by the same rule (the two share one definition, so they cannot drift).
A script - an imported collection's, say - therefore cannot plant a cookie for another site, nor delete that site's session.

- **The URL** a write names must be in scope, for all three methods.
- **For `set`, the cookie's `domain` must be in scope too.**
  Without the check a cookie `{ domain: 'victim.example', path: '/' }` set through a URL of `a.example` would be stored for `victim.example` and sent on the next transfer to it (cookie fixation).
  RFC 6265 section 5.3 has a user agent ignore a `Domain` that does not domain-match the request host; the jar does not apply that rule itself, so the engine checks it here, and it reads the match in both directions like the rest of the scope.
  A leading dot is ignored for the comparison and the domain is compared as punycode, as the jar keys on it.
  `Domain=example.com` set from a request to `www.example.com` is in scope and still stores.
- **A single-label domain is refused** (`.com`, `test`) unless it is exactly the request's host or one the script called (a request to `localhost` may write `domain: 'localhost'`).
  A top-level domain is a parent of every host under it, so the site rule alone would admit it, and the cookie would then be sent to every site there.
  **No public-suffix list is applied** (#2731): `co.uk` or `github.io` still passes as a domain, because telling it from `example.co.uk` needs the list.
- `clear()` with no URL empties this environment's jar and is not subject to the site limit (see above).

A refused write does not throw and stages nothing.
The call completes as an accepted write would - `set` returns (and passes the callback) the cookie it would have stored, `unset` the name - and the script's console gets one warning naming the host or domain, never the full URL:

```
pm.cookies.jar().set wrote nothing for the domain victim.example: a jar write is limited to the request's own site (a.example) and to hosts this script has called through pm.sendRequest. See docs/engine/scripting.md.
```

A bad argument is still the error it was; the site check runs after the arguments are validated.
A redirect target is not in scope for writes either.
A Postman script that logs in across hosts by `set`ting a cookie with a foreign `domain` stops working here; call the other host through `pm.sendRequest` first and its jar entries, and writes naming it, are in scope.

The flat `pm.cookies` reads need no such rule - they only ever read the request's own URL.
