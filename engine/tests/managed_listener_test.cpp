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

    const int port = listener.start ("127.0.0.1");
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
    const int port = first.start ("127.0.0.1");
    ASSERT_GT (port, 0);
    first.stop ();

    // The port is free again, so an explicit request for it is honoured
    // verbatim - the mock issuer's `port` setting rides on this.
    ManagedListener second;
    EXPECT_EQ (second.start ("127.0.0.1", port), port);
}

TEST (ManagedListener, ABindFailureStartsNothingAndReportsZero) {
    // TEST-NET-3 (RFC 5737): documentation-only, so it is never an address this
    // host holds and the bind fails the same way on all three platforms. A
    // port already in use is *not* the case to pin here - cpp-httplib binds
    // with SO_REUSEPORT, so a second listener on the same port succeeds on
    // Linux.
    ManagedListener contender;
    EXPECT_EQ (contender.start ("203.0.113.9"), 0);
    EXPECT_FALSE (contender.is_listening ());
    // Nothing was started, so the caller's own error path is the only outcome -
    // and stopping the failed listener must not hang on a thread that is not
    // there.
    contender.stop ();
    EXPECT_FALSE (contender.is_listening ());
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

    const int port = listener.start ("127.0.0.1");
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
    ASSERT_GT (started.start ("127.0.0.1"), 0);
    started.stop ();
    started.stop ();
    EXPECT_FALSE (started.is_listening ());
}

TEST (ManagedListener, RegisteringARouteAfterStopFailsLoudly) {
    // A route registered on a released listener would silently never be served;
    // saying so at the call site is the only way a caller can learn of it.
    ManagedListener listener;
    ASSERT_GT (listener.start ("127.0.0.1"), 0);
    listener.stop ();
    EXPECT_THROW (listener.server (), std::logic_error);
}

TEST (ManagedListener, StartingATwiceStartedListenerRefusesRatherThanLeaking) {
    ManagedListener listener;
    const int port = listener.start ("127.0.0.1");
    ASSERT_GT (port, 0);
    // A second start would overwrite the thread handle and leak the first
    // accept loop; it reports "nothing started" instead.
    EXPECT_EQ (listener.start ("127.0.0.1"), 0);
    EXPECT_TRUE (listener.is_listening ());

    httplib::Client client ("127.0.0.1", port);
    EXPECT_TRUE (client.Get ("/"))
    << "the original listener is still accepting";
}

} // namespace
