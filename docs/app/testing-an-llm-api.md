---
description: >-
  Testing an LLM API in Vayu - start from a streaming chat completion or messages template, read the reply as it streams, assert on it, load test it, and record token counts and cost as metrics.
---

# Testing an LLM API

Most LLM APIs speak one of two wire shapes: an OpenAI-compatible **chat
completion** or an Anthropic-style **messages** call, both answered as a
`text/event-stream`. Vayu ships a template for each, so the first send is
already a streaming request with the auth, headers, body and reply text set up.

The path is short: start from a template, set three variables, send and read the
reply, assert on it, then load test it.

## 1. Start from a template

Two entry points create the same request:

- The chevron beside **+** in the Collections sidebar, **New request from a
  template**.
- The command palette: **New request: Chat completion (OpenAI-compatible)** and
  **New request: Messages (Anthropic-style)**.

Either lands in the collection the **+** button would use, and opens the new
request.

| | Chat completion (OpenAI-compatible) | Messages (Anthropic-style) |
|---|---|---|
| Request | `POST {{baseUrl}}/chat/completions` | `POST {{baseUrl}}/v1/messages` |
| Auth | Bearer token `{{apiKey}}` | API key in the `x-api-key` header, `{{apiKey}}` |
| Other headers | `Content-Type: application/json`, `Accept: text/event-stream` | `anthropic-version: 2023-06-01`, `Content-Type: application/json`, `Accept: text/event-stream` |
| Body | `model`, `stream: true`, `stream_options.include_usage`, `messages` | `model`, `max_tokens`, `stream: true`, `messages` |
| Event stream | on | on |
| Stream text path | `$.choices[0].delta.content` | `$.delta.text` |
| Assertion | the body contains `[DONE]` | the body contains `message_stop` (Anthropic sends no `[DONE]`) |

A template carries no host, key or model name. Anything provider-specific
beyond the table, such as a `system` prompt or a different `max_tokens`, is an
edit to the request.

## 2. Set the variables

The templates read three variables. Define them as collection variables or in an
environment (see [Variables](variable-resolution.md)):

| Variable | Example |
|---|---|
| `baseUrl` | `https://api.openai.com/v1`, or `https://api.anthropic.com` for the messages template, or the address of a local OpenAI-compatible server |
| `apiKey` | your key |
| `model` | a model your account can call |

Without them the URL, the auth and the body show `{{baseUrl}}`, `{{apiKey}}` and
`{{model}}` unresolved. Pointing `baseUrl` at a local or mock server is a way to
build a test without spending anything.

## 3. Send and read the reply

Press Send. The request returns as soon as the stream opens, and the events
arrive in the response's **Events** tab. Its **Text** view joins what the
**Stream text path** (Settings tab, under **Event stream**) reads from each
event, so the reply reads as a sentence instead of a column of JSON chunks.

The path is a JSONPath read on each event's JSON data, in the same subset
`assert.jsonpath` reads (see [Elements](../engine/elements.md)). The two presets in the Settings tab are the two templates' paths. An event the
path does not match, such as a role-only chunk, a ping or the `[DONE]` sentinel,
is skipped. For a provider that streams a different shape, set the path to
wherever the text sits in one event; leave it empty to see rows only.

## 4. Assert

Each template's closing assertion is an **Assert text** element on the Elements
tab: it checks that the stream finished rather than being cut off. A streamed
step's body is the stream's `event:` and `data:` lines, so a word one event
carried is in the body the assertion searches.

Add more elements the same way. Common checks for an LLM endpoint:

- **Assert text** on the body for a string the answer must contain.
- A post-request script that reads the assembled reply, which exists whenever a
  stream text path is set:

  ```javascript
  pm.test('the model answered in French', function () {
      pm.expect(pm.response.streamText || '').to.include('Bonjour');
  });
  ```

The script runs once, after the stream has ended. See
[`pm.response.events`](../engine/scripting.md#pmresponseevents---a-streamed-runs-events)
for the event list, `pm.response.streamText` and the markers that say whether
the stored list was cut.

## 5. Load test

The **Load Test** button next to Send runs the request under load. A streaming
request gets two stream-only budgets in the dialog's **Pass/fail budgets**,
**Time to first event p95 at most** and **Events per second at least**, which
are the numbers that matter for an LLM: how long until the first token, and how
fast tokens arrive. The dialog also sets the caps a stream ends at.

Every request in a load test is a real call to the provider. It is billed, and
it counts against your rate limit, so start with a short run and a low rate, and
keep the template's `max_tokens` or an equivalent cap on the body.

## Recipes: tokens and cost

Vayu has no price table and no model list. Prices change and differ by account,
so cost is something you compute from the usage the API reports, with the price
as a variable you own.

Both recipes record a custom metric, and a custom metric belongs to a run: use
a load run of the request, or put it in a collection and use **Run collection**.
A single Send has no run to record into.

### Record token counts

Add a **Record a custom metric** element (`metric.record`) to the request, with
the counter type so the run reports a total:

| Reply | Source | Path |
|---|---|---|
| Non-streaming, OpenAI-compatible | JSONPath | `$.usage.completion_tokens` |
| Non-streaming, Anthropic-style | JSONPath | `$.usage.output_tokens` |
| Streaming, OpenAI-compatible | Stream event JSONPath | `$.usage.completion_tokens` |
| Streaming, Anthropic-style | Stream event JSONPath | `$.usage.output_tokens` |

A JSONPath source reads the response body, which is only the body of a reply
that was not streamed. A **Stream event JSONPath** source reads the last event of a
stream whose JSON data has a match, one value per stream, which is where a
stream puts its final usage. That is why the chat completion template sets
`stream_options.include_usage`: without it an OpenAI-compatible stream carries
no usage at all. The run reports the metric under its name in
`customMetrics`. The field names are the provider's, so check them against a
real reply. See [`metric.record`](../engine/elements.md#kinds) for the full
source list.

### Record cost

Cost is the usage times a price. Keep the price in variables, so it is one edit
when it changes. This post-request script is for a non-streaming step; the
prices are variables `priceInMicroUsd` and `priceOutMicroUsd`, in millionths of
a dollar per token, and the usage fields are OpenAI-compatible (an Anthropic-style
reply names them `input_tokens` and `output_tokens`):

```javascript
const usage = pm.response.json().usage;
const priceIn = Number(pm.variables.get('priceInMicroUsd'));
const priceOut = Number(pm.variables.get('priceOutMicroUsd'));

pm.metrics.counter('cost_microusd',
    usage.prompt_tokens * priceIn + usage.completion_tokens * priceOut);
```

Counting in millionths of a dollar keeps the counter a whole number of the
smallest unit you care about. `pm.metrics.counter` adds to a running total and
throws a `TypeError` for a negative or non-finite increment, so a price
variable that is not set (`NaN`) fails the script loudly rather than recording
nothing. The same call for a streamed OpenAI-compatible step reads the usage off the
events:

```javascript
const events = pm.response.events || [];
const usages = events
    .map(function (e) { try { return JSON.parse(e.data).usage; } catch (_) { return null; } })
    .filter(Boolean);
const usage = usages[usages.length - 1];

if (usage && !pm.response.eventsTruncated) {
    pm.metrics.counter('cost_microusd',
        usage.prompt_tokens * Number(pm.variables.get('priceInMicroUsd')) +
        usage.completion_tokens * Number(pm.variables.get('priceOutMicroUsd')));
}
```

Under a **scenario load run** a script runs after the run, on a sample, unless
the element's **Run inline** switch is on, and `pm.metrics` throws there. Turn
**Run inline** on for a script that records a metric. See
[Custom metrics](../engine/scripting.md#custom-metrics-pmmetrics) for where
`pm.metrics` is available.

### Budget the cost

A counter is reported as `value`, so a run can be failed on it. In the load
dialog or the collection run dialog, **Pass/fail budgets** has a **Custom metric
budgets** list: add `cost_microusd`, the stat `value` and a ceiling, which is
the threshold `custom.cost_microusd.value`. A run that spent more than the
ceiling fails that budget.
