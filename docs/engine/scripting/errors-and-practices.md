---
description: >-
  How script errors are reported, practices for writing scripts and where the API reference lives.
---

# Errors, best practices and the API reference

## Error Handling

Script errors are caught and reported:

```javascript
// If script throws, error is captured
try {
  const json = pm.response.json();
} catch (e) {
  // Error is reported in test results
}
```

Test failures don't stop script execution - all tests run and results are collected.

The message is never empty and never the bare `null` or `undefined` a value stringifies to (#3461).
An error with a message reads as it always has (`Error: boom`), and one with an empty message reads as its type (`TypeError`).
What has no text of its own reads as a sentence:

| The script | The message |
|------------|-------------|
| Runs out of memory | `Script ran out of memory at the 1 MiB limit` (the configured `scriptMemoryLimit`) |
| `throw undefined` | `Script threw undefined` |
| `throw ''` | `Script threw an empty string` |
| Throws an object whose `toString` gives `''` or throws | `Script threw a value with no text` |
| `throw null` | `Script threw null` |

Running out of memory is read from the engine's record that the limit refused an allocation, never from the thrown value (#3460).
QuickJS words a refusal by where it lands: its own out-of-memory error, a bare `null` when there was no room left to build that, or, inside its parser, a `SyntaxError` such as `invalid assignment left-hand side`.
A `null` with no refusal behind it is the script's own `throw null`.
Any other error after a refusal keeps its text after the sentence, because a script can catch the `null` and throw something else: `Script ran out of memory at the 1 MiB limit (then failed with: SyntaxError: invalid assignment left-hand side)`.
A `pm.test` row that runs out reports it on its row, and the rows after it report their own errors.
The same text stands in for the reason of an unhandled promise rejection (`Unhandled promise rejection: Script threw undefined`).

A failed `pm.test` row (and a legacy `tests[name]` getter that throws) reads the same way: `pm.test('x', () => { throw undefined })` gives the row the error `Script threw undefined`, `throw new Error('')` gives `Error`, and `throw new Error('boom')` still gives `Error: boom`.

In a collection run an uncaught error marks the step `errored`, with the message on its row, and the iteration moves on to the next request, as Postman's runner does; `stopOnError: true` on the run ends the iteration there instead.
See [Flow control](execution-metrics-data.md#flow-control-pmexecution) for what happens to a redirect the script made before it threw.

## Best Practices

1. **Use descriptive test names**: `pm.test('Status code is 200', ...)`
2. **Validate structure before accessing**: Check if JSON exists before accessing properties
3. **Use environment variables**: Store sensitive data in environments, not scripts
4. **Keep scripts simple**: Complex logic should be in your application code
5. **Log debugging info**: Use `console.log()` to debug script issues

## API Reference

For complete API documentation, see the [Scripting Completions API](../api-reference/scripting.md#scripting) which lists all available `pm.*` functions and properties.
