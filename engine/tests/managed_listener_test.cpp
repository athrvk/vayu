/**
 * @file tests/managed_listener_test.cpp
 * @brief Tests for the shared on-demand listener lifecycle (issue #505): the
 *        bind/accept/stop contract every listener-owning manager runs on, and
 *        the case each of them used to pin separately - tearing down while a
 *        handler is still in flight.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "vayu/http/managed_listener.hpp"

using vayu::http::ManagedListener;

namespace {

TEST (ManagedListener, StartsAcceptingOnAnEphemeralPort) {
    ManagedListener listener;
    listener.server ().Get ("/ping", [] (const httplib::Request&, httplib::Response& res) {
        res.set_content ("pong", "text/plain");
    });

    const int port = listener.start ("127.0.0.1").port;
    ASSERT_GT (port, 0);
    EXPECT_TRUE (listener.is_listening ());

    httplib::Client client ("127.0.0.1", port);
    auto response = client.Get ("/ping");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);
    EXPECT_EQ (response->body, "pong");
}

TEST (ManagedListener, StartReturnsTheRequestedPortWhenOneIsAsked) {
    ManagedListener first;
    const int port = first.start ("127.0.0.1").port;
    ASSERT_GT (port, 0);
    first.stop ();

    // The port is free again - and the claim stop() released with it - so an
    // explicit request for it is honoured verbatim; the mock issuer's `port`
    // setting rides on this.
    ManagedListener second;
    const auto outcome = second.start ("127.0.0.1", port);
    EXPECT_EQ (outcome.port, port);
    EXPECT_EQ (outcome.held_by, "");
}

TEST (ManagedListener, ABindFailureStartsNothingAndReportsZero) {
    // TEST-NET-3 (RFC 5737): documentation-only, so it is never an address this
    // host holds and the bind fails the same way on all three platforms. A
    // port already in use is a *different* outcome - see the port-guard tests
    // below - because cpp-httplib binds with SO_REUSEPORT and the kernel would
    // otherwise accept the second bind on Linux.
    ManagedListener contender;
    const auto outcome = contender.start ("203.0.113.9");
    EXPECT_EQ (outcome.port, 0);
    EXPECT_EQ (outcome.held_by, "") << "no listener holds this address";
    EXPECT_FALSE (contender.is_listening ());
    // Nothing was started, so the caller's own error path is the only outcome -
    // and stopping the failed listener must not hang on a thread that is not
    // there.
    contender.stop ();
    EXPECT_FALSE (contender.is_listening ());
}

TEST (ManagedListener, AnExplicitPortAnotherListenerHoldsIsRefusedAndNamesTheHolder) {
    // The bug this guard exists for (#512): without it the second bind succeeds
    // on Linux and the kernel splits arriving connections between the two
    // accept loops, so each listener answers a random half of the traffic.
    ManagedListener holder;
    holder.server ().Get ("/who", [] (const httplib::Request&, httplib::Response& res) {
        res.set_content ("holder", "text/plain");
    });
    const int port = holder.start ("127.0.0.1", 0, "inbox inbox_first").port;
    ASSERT_GT (port, 0);

    ManagedListener contender;
    contender.server ().Get ("/who", [] (const httplib::Request&, httplib::Response& res) {
        res.set_content ("contender", "text/plain");
    });
    const auto refused = contender.start ("127.0.0.1", port, "inbox inbox_second");
    EXPECT_EQ (refused.port, 0);
    EXPECT_EQ (refused.held_by, "inbox inbox_first");
    EXPECT_FALSE (contender.is_listening ());

    // The holder still answers everything sent to the port - the split is what
    // makes the missing captures invisible, so pin that it did not happen.
    httplib::Client client ("127.0.0.1", port);
    for (int i = 0; i < 8; ++i) {
        auto response = client.Get ("/who");
        ASSERT_TRUE (response) << "request " << i << " reached nothing";
        EXPECT_EQ (response->body, "holder") << "request " << i << " was split away";
    }
}

TEST (ManagedListener, ThePortGuardSpansListenerFamilies) {
    // The two managers that accept an explicit port are separate objects with
    // separate locks, so the claim has to be process-wide rather than per
    // manager - an issuer must not land on an inbox's port either.
    ManagedListener inbox;
    const int port = inbox.start ("127.0.0.1", 0, "inbox inbox_x").port;
    ASSERT_GT (port, 0);

    ManagedListener issuer;
    EXPECT_EQ (issuer.start ("127.0.0.1", port, "mock issuer issuer_y").held_by, "inbox inbox_x");

    // And the claim goes away with its listener, not with the process.
    inbox.stop ();
    ManagedListener later;
    EXPECT_EQ (later.start ("127.0.0.1", port, "inbox inbox_z").port, port);
}

TEST (ManagedListener, AnUnlabelledHolderIsStillNamedSomething) {
    // Nothing in the engine starts a listener without a label, but a caller
    // that forgets one must not produce "Could not bind ... -  is already
    // listening there".
    ManagedListener holder;
    const int port = holder.start ("127.0.0.1").port;
    ASSERT_GT (port, 0);

    ManagedListener contender;
    EXPECT_EQ (contender.start ("127.0.0.1", port, "inbox inbox_b").held_by, "another listener");
}

TEST (ManagedListener, StopJoinsAHandlerThatIsStillRunning) {
    // The case every manager needs and each used to pin on its own: a request
    // is inside its handler when teardown starts. stop() must not return - and
    // must not tear the server out from under the handler - until it finishes.
    ManagedListener listener;
    std::atomic<bool> handler_entered{ false };
    std::atomic<bool> handler_finished{ false };

    listener.server ().Get ("/slow", [&] (const httplib::Request&, httplib::Response& res) {
        handler_entered.store (true);
        std::this_thread::sleep_for (std::chrono::milliseconds (300));
        handler_finished.store (true);
        res.set_content ("done", "text/plain");
    });

    const int port = listener.start ("127.0.0.1").port;
    ASSERT_GT (port, 0);

    std::thread caller ([port] {
        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (5, 0);
        client.Get ("/slow");
    });

    for (int i = 0; i < 500 && !handler_entered.load (); ++i) {
        std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }
    ASSERT_TRUE (handler_entered.load ()) << "the handler never ran";

    listener.stop ();
    // The join is the whole point: after stop() returns, no handler is still
    // reading the state its owner is about to destroy.
    EXPECT_TRUE (handler_finished.load ());
    EXPECT_FALSE (listener.is_listening ());
    caller.join ();
}

TEST (ManagedListener, StopIsIdempotentAndSafeWithoutAStart) {
    // The authorize manager tears down on every terminal status() poll, so a
    // second stop() must be a no-op rather than a double join.
    ManagedListener never_started;
    never_started.stop ();
    never_started.stop ();
    EXPECT_FALSE (never_started.is_listening ());

    ManagedListener started;
    ASSERT_GT (started.start ("127.0.0.1").port, 0);
    started.stop ();
    started.stop ();
    EXPECT_FALSE (started.is_listening ());
}

TEST (ManagedListener, RegisteringARouteAfterStopFailsLoudly) {
    // A route registered on a released listener would silently never be served;
    // saying so at the call site is the only way a caller can learn of it.
    ManagedListener listener;
    ASSERT_GT (listener.start ("127.0.0.1").port, 0);
    listener.stop ();
    EXPECT_THROW (listener.server (), std::logic_error);
}

TEST (ManagedListener, StartingATwiceStartedListenerRefusesRatherThanLeaking) {
    ManagedListener listener;
    const int port = listener.start ("127.0.0.1").port;
    ASSERT_GT (port, 0);
    // A second start would overwrite the thread handle and leak the first
    // accept loop; it reports "nothing started" instead.
    EXPECT_EQ (listener.start ("127.0.0.1").port, 0);
    EXPECT_TRUE (listener.is_listening ());

    httplib::Client client ("127.0.0.1", port);
    EXPECT_TRUE (client.Get ("/"))
    << "the original listener is still accepting";
}

} // namespace
