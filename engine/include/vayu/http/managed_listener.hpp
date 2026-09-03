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
 * - **Refuse a port another listener holds.** The bind cannot do it:
 *   cpp-httplib sets `SO_REUSEPORT`, so on Linux a second bind on the same
 *   `127.0.0.1:port` succeeds and the kernel then splits arriving connections
 *   between the two accept loops - two inboxes, each capturing a random half of
 *   the webhooks (issue #512). Every live listener therefore claims its
 *   address:port here, and an explicitly requested port that is already claimed
 *   is refused before the bind, naming the holder.
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
    /**
     * Take a server the owner built, for a listener that needs one a plain
     * `httplib::Server` cannot be - the webhook inbox routes every request as
     * one path through a `Server` subclass, so that a path cpp-httplib's regex
     * matcher would refuse still reaches its handler (see routes/inbox.cpp).
     *
     * Throws `std::invalid_argument` on a null server rather than letting it
     * read back as a listener `stop()` has already released.
     */
    explicit ManagedListener (std::unique_ptr<httplib::Server> server);
    /// Stops and joins, so a manager destroying its records never leaks a thread.
    ~ManagedListener ();

    ManagedListener (const ManagedListener&)            = delete;
    ManagedListener& operator= (const ManagedListener&) = delete;
    ManagedListener (ManagedListener&&)                 = delete;
    ManagedListener& operator= (ManagedListener&&)      = delete;

    /**
     * The server to register routes and options on, before `start()`.
     *
     * Throws `std::logic_error` after `stop()` has run: the server is released
     * there, and a route registered on a listener that no longer exists would
     * otherwise be a silent no-op (or worse, a null dereference).
     */
    httplib::Server& server ();

    /// What `start()` did. Nothing is listening whenever `port` is 0, and the
    /// caller owns the error it reports either way; `held_by` is what separates
    /// the two reasons it can be 0 by the time a socket was tried.
    struct StartOutcome {
        /// The bound port, or 0 when nothing is listening.
        int port = 0;
        /// Names the listener already holding the requested address:port (e.g.
        /// `"inbox inbox_2f1c"`) when that is why `port` is 0. Empty for every
        /// other outcome, so a caller can tell a port this engine already holds
        /// from a bind that failed for any other reason.
        std::string held_by;
    };

    /**
     * Bind @p bind_address (@p port, or an ephemeral port when 0) and start
     * accepting, claiming the bound address:port for as long as this listener
     * runs. @p owner_label names this listener in the refusal another manager
     * gets when it asks for the same port.
     *
     * An explicitly requested port already claimed by a live listener is
     * refused without touching a socket - see the class comment on
     * `SO_REUSEPORT`. An ephemeral request is not checked: the kernel does not
     * hand out a port it is already using.
     */
    StartOutcome start (const std::string& bind_address,
    int port                       = 0,
    const std::string& owner_label = {});

    /**
     * Stop accepting, join the listener thread, release the server and the port
     * claim. Idempotent and safe on a listener that never started; returns only
     * once no handler is still running, which can take as long as the slowest
     * one - and once the port is claimable again.
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
