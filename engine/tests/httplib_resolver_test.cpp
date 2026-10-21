/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/httplib_resolver_test.cpp
 * @brief cpp-httplib resolves names on its synchronous branch (#2667).
 *
 * The why is beside the filter after `find_package(httplib)` in
 * `engine/CMakeLists.txt`. The defect it removes cannot be provoked on
 * demand: it needs glibc's resolver thread to be descheduled between
 * finishing one request and retiring it, which only an oversubscribed machine
 * does, and rarely. So the configuration is what is pinned, read where it
 * matters - in a translation unit that links httplib::httplib.
 */

#include <gtest/gtest.h>

namespace {

// Mutation check: delete the filter in engine/CMakeLists.txt and this fails.
TEST (HttplibResolverTest, ClientsResolveWithoutGlibcsAsyncResolver) {
#ifdef CPPHTTPLIB_USE_NON_BLOCKING_GETADDRINFO
    FAIL ()
    << "httplib::httplib defines CPPHTTPLIB_USE_NON_BLOCKING_GETADDRINFO "
       "again: on glibc that branch leaves a resolve running against a "
       "returned stack frame";
#else
    SUCCEED ();
#endif
}

} // namespace
