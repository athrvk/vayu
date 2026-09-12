---
description: >-
  What carries over when you import a JMeter .jmx test plan into Vayu - the JMeter-class-to-element-kind mapping, URL and header assembly, and what gets counted rather than imported.
---

# JMeter `.jmx` Test Plan

Parses a JMeter `.jmx` test plan (JMeter's own `<jmeterTestPlan>`/`<hashTree>` XML dialect) into the Vayu draft model. Issue [#1518](https://github.com/athrvk/vayu/issues/1518).

- **Source:** `engine/src/core/jmeter_import.cpp` (`engine/include/vayu/core/jmeter_import.hpp`)
- **Reader:** pugixml, the one XML dependency in one translation unit - the same "one reader" rule `core::read_document` (JSON/YAML) and `core::openapi_document.cpp` (the YAML half of that) already follow, extended to a third dialect neither of those readers can parse.

## Detection

A `.jmx` file is XML, so it fails both of `core::read_document`'s readers (JSON, then YAML) the same way genuinely unrecognised bytes do. `is_jmeter_document` checks the raw text for `<jmeterTestPlan` within its first 4096 bytes, **before** `parse_import` ever calls `read_document` - the one exception to every other format's "one JSON/YAML read, then dispatch on the parsed document" rule (see the [parser-architecture README](./README.md#adding-a-new-format)).

## The tree walk

A `.jmx` file's `<hashTree>` children alternate a test element (`<ThreadGroup>`, `<HTTPSamplerProxy>`, ...) with that element's own `<hashTree>` of children - JMeter's own serialization shape. The walk pairs them (`for_each_paired_child`) and dispatches on the element's tag name; nothing here is detected by `guiclass` except JMeter's own `HttpDefaultsGui` marker on a bare `ConfigTestElement` (JMeter reuses that one tag for several unrelated config panels).

**`enabled="false"` excludes an element and everything nested under it**, the same way JMeter itself never runs a disabled element's children either - checked once, in `for_each_paired_child` itself, so no individual dispatch site can forget it. Counted as `<Tag>_disabled` (e.g. `HTTPSamplerProxy_disabled`) rather than importing a request or controller the user had turned off as active with no way to disable it again.

- **`TestPlan` and `ThreadGroup`** flatten straight into the enclosing collection - Vayu has no thread-group concept, since a collection already runs every request once. A `TestPlan`'s own `TestPlan.user_defined_variables` becomes collection variables.
- **`SetupThreadGroup` / `PostThreadGroup`** (JMeter's setUp/tearDown thread groups) look inside for a JSR223 or BeanShell sampler/pre/post-processor and take its script text as `script.setup` / `script.teardown` (concatenated if more than one). A group whose body is ordinary samplers - not a script - has no equivalent and is counted by its own tag name instead of being guessed at.
- **A folder-shaping controller** (`LoopController`, `IfController`, `OnceOnlyController`, `SwitchController`, `TransactionController`, `ThroughputController`) becomes a Vayu folder, walked the same way, with its own `control.*` element attached when the controller could be translated (see the table below). The folder still imports - and its members with it - even when the controller itself could not be (an unparseable `IfController.condition`, a `LoopController` set to JMeter's "forever", or `SwitchController`, which this parser never translates) - counted under `<Tag>_unrecognised` in `meta.skipped` the same way `build_leaf_element` counts a recognised leaf kind it could not extract enough from, per the "nothing dropped quietly" rule below.
- **`HTTPSamplerProxy`** becomes a request; see [Request mapping](#request-mapping).
- **Everything else** (`Arguments`, HTTP defaults, and every extractor/assertion/timer/script kind in the table) attaches to whichever sink is walking when it is met: a sampler's own `<hashTree>` if this parser is inside one ([Request mapping](#request-mapping)), the enclosing folder's or the collection's own `elements` otherwise - the same inheritance a Vayu-authored collection-level element already gets. A `HeaderManager` or a leaf kind met at the collection/folder level is not scoped down to "every sampler after it" the way JMeter's own scoping would place it; this parser does not attempt to resolve JMeter's positional scoping rules.

## Class mapping

| JMeter class | Vayu | Notes |
|---|---|---|
| `TestPlan`, `ThreadGroup` | flattens into the collection | no per-user loop count, no thread count - a load run configures those separately |
| `SetupThreadGroup`, `PostThreadGroup` | `script.setup`, `script.teardown` | only when a JSR223/BeanShell script is found inside; otherwise counted |
| `HTTPSamplerProxy` (+ `HeaderManager` in its own `<hashTree>`) | a request, with headers | see [Request mapping](#request-mapping); `HTTPSampler.follow_redirects` / `HTTPSampler.auto_redirects` (either true means Vayu's `followRedirects` is true) carry through; `HTTPsampler.Files` (a multipart file upload) has no formdata-part model yet ([issue #1657](https://github.com/athrvk/vayu/issues/1657)) and is counted as `HTTPsampler.Files` rather than dropped silently, since it is nested inside the sampler tag itself and would otherwise never reach the sibling-tag tally |
| `LoopController` | folder + `control.loop` | `LoopController.loops` of `-1` (JMeter's "forever") has no `control.loop` equivalent - the folder still imports as a plain grouping |
| `IfController` | folder + `control.if` | only the `"${var}" == "value"` / `!=` shape translates into `{{var}} == value`; anything else (a JS expression, `&&`/`||`) is left unmapped |
| `OnceOnlyController` | folder + `control.once` | |
| `TransactionController` | folder + `control.transaction` | named from `testname` |
| `ThroughputController` | folder + `control.throughput` | from `ThroughputController.percentThroughput` |
| `SwitchController` | folder only | JMeter selects by list index or a raw variable value, neither of which maps onto `control.switch`'s named-case grammar without inventing case names the plan never declared |
| `JSONPostProcessor` | `extract.json` | only the first of a `;`-separated multi-value processor is imported |
| `RegexExtractor` | `extract.regex` | `useHeaders` maps to `field: "headers"` |
| `BoundaryExtractor` | `extract.boundary` | a new kind this issue adds - `leftBoundary`/`rightBoundary`, JMeter has no field selector for one either |
| `ResponseAssertion` | `assert.status` (test field is response code) or `assert.contains` (otherwise) | `Assertion.test_type`'s Equals bit (`8`) maps to `mode: "equals"`; everything else reads as `contains`. `Assertion.test_field` selects `assert.contains`'s own `field`: `Assertion.response_headers` → `headers`, `Assertion.sample_label` ("URL Sampled") → `url`, absent/`Assertion.response_data` → `body`; any other value (Request Data, Request Headers, Response Message, Document) has no field to land on and is refused rather than collapsed onto `body`, counted as `ResponseAssertion_unrecognised` |
| `DurationAssertion` | `assert.duration` | |
| `SizeAssertion` | `assert.size` | only JMeter's Equal operator maps precisely (`op: "eq"`); every other operator code has drifted across JMeter releases and falls back to `assert.size`'s own default (`lte`) |
| `JSONPathAssertion` | `assert.jsonpath` | `INVERT` → `negate`; `JSONVALIDATION` + `EXPECTED_VALUE` → `expected`, else `exists: true` |
| `ConstantTimer` | `timer.think` (fixed `ms`) | |
| `UniformRandomTimer` | `timer.think` (`minMs`/`maxMs`) | `ConstantDelay` is the floor, `+ RandomTime.range` the ceiling |
| `GaussianRandomTimer` | `timer.think` (`gaussian`) | `ConstantDelay` → `meanMs`, `RandomTime.range` → `deviationMs` |
| `ConstantThroughputTimer` | `timer.pacing` | JMeter's rate is samples/minute; `everyMs = 60000 / throughput`. `calcMode == 0` ("this thread only") is `perUser: true`, every other mode `perUser: false` |
| `JSR223Pre/PostProcessor`, `BeanShellPre/PostProcessor` | `script.pre` / `script.post`, imported **disabled** | Groovy and BeanShell are not JavaScript; the element carries the source text as a comment when JMeter's own `script` property is empty |
| `Arguments` (User Defined Variables) | collection variables | merged wherever the node sits in the tree (`TestPlan`, or a bare `Arguments` node) |
| `ConfigTestElement` with `guiclass="HttpDefaultsGui"` (HTTP Request Defaults) | the collection's `baseUrl` variable | only when it names a domain |
| `WhileController`, `RandomOrderController`, `InterleaveController`, `XPathExtractor`, `XPath2Extractor`, `CookieManager`, `CSVDataSet`, `AuthManager`, every listener (`ResultCollector` and its kin) | not mapped | counted by class name - see [Drop counting](#drop-counting) |

## Request mapping

One `HTTPSamplerProxy` becomes one request:

- **URL.** `HTTPSampler.domain` present → an absolute URL (`protocol://domain[:port]path`, `${var}` rewritten to `{{var}}`); absent → `{{baseUrl}}` + path, so a sampler that relies on a plan-level HTTP Request Defaults element still resolves once that element's `baseUrl` variable is set.
- **Body.** `HTTPSampler.postBodyRaw` true and at least one argument → `{mode: "text", content: <the one argument's value>}`. Otherwise every `HTTPsampler.Arguments` entry becomes a `params` row (enabled), regardless of HTTP method - the same "declare it as a row" shape every other importer here uses; nothing here decides GET-vs-body for you.
- **Headers.** A `HeaderManager` directly inside the sampler's own `<hashTree>` becomes the request's `headers` rows.
- **Elements.** Every recognised extractor/assertion/timer/processor directly inside the sampler's own `<hashTree>` becomes a request-level element, in encounter order.

## Drop counting

Every class this parser has no mapping for - and every recognised class it could not extract enough from (an empty pattern, an unparsable delay) - is counted under its own literal tag name (`meta.skipped`), shown in the import preview the same way every other format's losses are (issue [#1443](https://github.com/athrvk/vayu/issues/1443), "nothing dropped quietly"). JMeter's own class list is open-ended - third-party plugins add more of them - so this is not the closed, enumerable `SkippedItem.kind` set every other format counts against: `ImportTally::items()` falls back to emitting any kind outside its fixed order list (in first-encountered order) rather than silently losing it, and the app's `SKIPPED_LABELS` map (`ImportModal.tsx`) renders the raw class name for one with no hand-written label.

An element this parser *does* build is still validated against the live element registry (`Registry::validate`) before it reaches the draft, the same gate a stored request's own write goes through - a mistranslation is dropped and counted as `<kind>_unmappable` rather than reaching `POST /import/apply`, whose write is atomic across the whole tree.

## Related

- [Import Collections - Parser Architecture](./README.md)
- [`docs/engine/elements.md`](../../engine/elements.md) - the element registry every mapped kind above targets
- [`docs/compare/vayu-vs-jmeter.md`](../../compare/vayu-vs-jmeter.md)
