#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <httplib.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

namespace vayu::http {

/**
 * One on-demand listener: an `httplib::Server`, the thread accepting on it, and
 * the start/stop discipline both need to be correct.
 *
 * The engine opens a listener per OAuth callback attempt, per mock issuer and
 * per webhook inbox (see docs/engine/architecture.md#listeners). Each of those
 * managers used to hand-roll the same four steps, and the steps are subtle:
 *
 * - **Bind before listening.** `bind_to_any_port` / `bind_to_port` report the
 *   failure a `listen()` on a taken port would only ever log, so the caller can
 *   answer its own error rather than leaving a thread spinning.
 * - **Return only once the accept loop is live.** `stop()` racing ahead of
 *   `listen()` is *missed* by cpp-httplib, and the `join()` that follows then
 *   hangs forever. `start()` therefore does not return until the server reports
 *   itself running (or the spin bound elapses).
 * - **Stop, then join, then drop the server.** A request still in a handler
 *   holds the listener thread, so the join is the thing that makes "stopped"
 *   mean "nothing is touching my state any more".
 * - **Own the listener last.** Whatever a handler reaches for - a canned
 *   response, an issuer's token maps, an attempt's config - must outlive the
 *   thread reading it, so the `ManagedListener` member is declared **last** in
 *   its owner and is therefore destroyed **first**. The same reverse-member-order
 *   rule puts the three managers before `server_` in server.hpp.
 *
 * Thread-safe against concurrent `stop()`s and `is_listening()` reads only in
 * the sense each manager needs: `start()` and `stop()` are called under the
 * owning manager's lock (or on an object no other thread can reach yet), while
 * `is_listening()` is a plain atomic read.
 */
class ManagedListener {
    public:
    ManagedListener ();
    /// Stops and joins, so a manager destroying its records never leaks a thread.
    ~ManagedListener ();

    ManagedListener (const ManagedListener&)            = delete;
    ManagedListener& operator= (const ManagedListener&) = delete;

    /**
     * The server to register routes and options on, before `start()`.
     *
     * Throws `std::logic_error` after `stop()` has run: the server is released
     * there, and a route registered on a listener that no longer exists would
     * otherwise be a silent no-op (or worse, a null dereference).
     */
    httplib::Server& server ();

    /**
     * Bind @p bind_address (@p port, or an ephemeral port when 0) and start
     * accepting.
     *
     * @return the bound port, or 0 when the bind failed or this listener was
     *         already started - nothing is running in either case, and the
     *         caller owns the error it reports.
     */
    int start (const std::string& bind_address, int port = 0);

    /**
     * Stop accepting, join the listener thread, release the server. Idempotent
     * and safe on a listener that never started; returns only once no handler
     * is still running, which can take as long as the slowest one.
     */
    void stop ();

    /// True between a successful `start()` and `stop()`.
    bool is_listening () const;

    private:
    std::unique_ptr<httplib::Server> server_;
    std::thread listen_thread_;
    std::atomic<bool> listening_{ false };
};

} // namespace vayu::http
