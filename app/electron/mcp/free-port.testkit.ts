/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import net from "node:net";

/**
 * A loopback port the OS just reported free. A test that listens on a fixed
 * number fails with EADDRINUSE whenever anything else on the runner holds it -
 * another test file in the same worker pool, a parallel job, a Windows
 * reserved range - which is a red run that says nothing about the code.
 */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}
