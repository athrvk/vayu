---
description: >-
  Practices for code that calls the engine, how to mock the API in tests, and what to check when the engine or SSE does not respond.
---

# Best practices, testing and troubleshooting

## Best Practices

1. **Always use `apiService`**: Don't call `httpClient` directly
2. **Handle errors**: Always wrap API calls in try/catch
3. **Use user-friendly messages**: Display `error.userFriendlyMessage` to users
4. **Transform data**: Use service layer for format transformation
5. **Cache queries**: Use TanStack Query for automatic caching
6. **Disconnect SSE**: Always disconnect SSE when component unmounts

## Testing

### Mocking API Calls

Use TanStack Query's query client for testing:

```typescript
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } }
});
```

### Mocking Services

Mock `apiService` methods:

```typescript
jest.spyOn(apiService, 'executeRequest').mockResolvedValue(mockResponse);
```

## Troubleshooting

### Engine Not Responding

1. Check the Dock: hovering "Engine connected" shows the address the app is using, and the disconnected state says why.
   "Another program is using port 9876, and the fallback ports are held too" means every candidate is held; free 9876 (Retry looks there alone) and press Retry.
   "Another Vayu engine" in its place means a Vayu engine serving another data directory holds 9876; the app never stops it, so stop it yourself and press Retry.
2. Check if engine is running: `curl <address from the Dock>/health` (9876 unless the app fell back)
3. Check engine logs in Electron console

### SSE Not Connecting

1. Verify load test is running (`status: "running"`)
2. Check browser console for SSE errors
3. Verify endpoint: `/runs/:runId/live` or `/runs/:runId/metrics`

### CORS Errors

The engine sends no CORS header and refuses any request carrying `Origin`; the renderer gets through only because the Electron shell's bridge (`app/electron/engine-origin.ts`) strips `Origin` and `Referer` from requests to exactly `ENGINE_BASE_URL` and adds the CORS response headers.
A CORS error or a `403` naming browser origins therefore means:
- The request did not go through `ENGINE_BASE_URL` (`src/config/network.ts`) - the same engine spelled `localhost:<port>` is outside the bridge's filter
- The page is not running in the app's own window session (plain Chromium, or a window the bridge was never installed on); see "Driving the renderer without Electron" in `app/CLAUDE.md` for the bridge a test browser needs
