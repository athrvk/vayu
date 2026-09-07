/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/*
 * libuv creates its threadpool workers with an explicit 8 MB stack, and on
 * Windows `_beginthreadex` commits that size rather than reserving it, so the
 * pool's first use - electron-updater's async read of app-update.yml at the
 * first update check - commits 4 x 8 MB this process never touches (+32 MB of
 * commit charge, measured, working set unchanged). Everything the main process
 * hands the pool is serial by construction: one user file per dialog, the
 * updater's own writes. One worker serves that; a size the environment already
 * carries wins, which is how a developer overrides it.
 *
 * The pool reads the variable once, at its first use, so this is main.ts's
 * first import - ahead of any module that could touch the filesystem while
 * loading.
 */
process.env.UV_THREADPOOL_SIZE ??= "1";

// A statement alone is a script to TypeScript; this is the module Node runs it as.
export {};
