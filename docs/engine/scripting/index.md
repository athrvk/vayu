---
description: >-
  Writing pre-request and test scripts in Vayu - the QuickJS sandbox, the pm API, script hooks, execution order and limits.
---

# Vayu Scripting Guide

Vayu uses QuickJS for JavaScript execution in pre-request and test scripts.
The scripting API is compatible with Postman's `pm` object, making it easy to migrate tests from Postman.

## Pages

Each page holds one `pm.*` area or one part of the sandbox.

| Page | Covers |
|---|---|
| [The `pm` Object](test-and-expect.md) | `pm.test()`, `pm.expect()` |
| [Response Object (`pm.response`)](response.md) | `pm.response`: status, events, mcp, redirects |
| [Response headers, cookies and assertions](response-headers-and-assertions.md) | `pm.response` headers, cookies and assertions |
| [Request Object (`pm.request`)](request.md) | `pm.request`: reading the request |
| [Mutating the request](request-mutation.md) | `pm.request.headers`, `pm.request.addHeader`, `pm.request.url` |
| [Script identity, setup and teardown](info-and-setup.md) | `pm.info`, setup and teardown scripts |
| [Variables and environments](variables.md) | `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables` |
| [Sending a request from a script (`pm.sendRequest`)](send-request.md) | `pm.sendRequest` |
| [The cookie jar (`pm.cookies`)](cookies.md) | `pm.cookies`, `pm.cookies.jar()` |
| [Flow control, metrics and data rows](execution-metrics-data.md) | `pm.execution`, `pm.metrics`, `pm.iterationData` |
| [Console output and examples](console-and-examples.md) | `console`, examples, worked request rewrites |
| [The sandbox](sandbox.md) | Isolation, compute, timers, top-level `await` |
| [The `require` shelf](require-shelf.md) | `require` |
| [Legacy postman objects and the visualizer](legacy-and-visualizer.md) | `postman`, legacy globals, `pm.visualizer` |
| [Editor support and limitations](limitations.md) | The script editor, limitations |
| [Where each kind of script runs](execution-context.md) | Pre-request, test and load test scripts, script elements |
| [Errors, best practices and the API reference](errors-and-practices.md) | Error handling, best practices |

## Quick Start

```javascript
// Test script example
pm.test('Status is 200', function() {
  pm.expect(pm.response.code).to.equal(200);
});

pm.test('Response has user data', function() {
  const json = pm.response.json();
  pm.expect(json).to.have.property('id');
  pm.expect(json.name).to.be.a('string');
});
```
