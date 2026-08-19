/**
 * @file tests/http_version_support_test.cpp
 * @brief Gate tests for the two build-level preconditions of HTTP/2. Either
 *        one missing makes every httpVersion setting downstream
 *        (CURLOPT_HTTP_VERSION_2TLS, the Auto mapping, the request builder's
 *        HTTP Version control) a silent no-op with all traffic on HTTP/1.1:
 *        libcurl must carry nghttp2, and on Windows this process must not be
 *        lied to about the OS version.
 */

#include <curl/curl.h>
#include <gtest/gtest.h>

#ifdef _WIN32
#include <windows.h>
#endif

// The whole HTTP/2 feature rests on libcurl being built with nghttp2. Without
// the vcpkg `http2` feature this bit is off and every httpVersion setting is a
// silent no-op, which is exactly the state this test was written to prevent
// recurring.
TEST (HttpVersionSupport, LibcurlWasBuiltWithHttp2) {
    const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
    ASSERT_NE (info, nullptr);
    EXPECT_TRUE ((info->features & CURL_VERSION_HTTP2) != 0)
    << "libcurl reports: " << curl_version ()
    << "\nExpected nghttp2. Check engine/vcpkg.json requests curl[http2].";
}

#ifdef _WIN32

namespace {

/**
 * Ask Windows "is this OS at least major.minor?" the way curl asks it.
 *
 * Deliberately a re-creation of curlx_verify_windows_version()'s call shape
 * (lib/curlx/version_win32.c) rather than something simpler: the point of the
 * test below is that libcurl's *own* answer decides whether ALPN is enabled,
 * and an approximation of the question could agree with curl by accident.
 *
 * `use_rtl` picks the API. ntdll's RtlVerifyVersionInfo reports the true OS.
 * VerifyVersionInfoW is version-shimmed and caps its answer at 6.2 unless the
 * process carries a manifest declaring support for a later OS - which is the
 * whole subject of this test.
 */
bool os_at_least (DWORD major, DWORD minor, bool use_rtl) {
    // Same layout as RTL_OSVERSIONINFOEXW / OSVERSIONINFOEXW - the two agree on
    // the fields, which is why curl passes one struct to both entry points.
    OSVERSIONINFOEXW osver{};
    osver.dwOSVersionInfoSize = sizeof (osver);
    osver.dwMajorVersion      = major;
    osver.dwMinorVersion      = minor;
    osver.dwPlatformId        = VER_PLATFORM_WIN32_NT;

    ULONGLONG mask = 0;
    mask           = VerSetConditionMask (mask, VER_MAJORVERSION, VER_GREATER_EQUAL);
    mask           = VerSetConditionMask (mask, VER_MINORVERSION, VER_GREATER_EQUAL);
    mask = VerSetConditionMask (mask, VER_SERVICEPACKMAJOR, VER_GREATER_EQUAL);
    mask = VerSetConditionMask (mask, VER_SERVICEPACKMINOR, VER_GREATER_EQUAL);
    mask = VerSetConditionMask (mask, VER_PLATFORMID, VER_EQUAL);

    const DWORD type_mask = VER_MAJORVERSION | VER_MINORVERSION |
    VER_SERVICEPACKMAJOR | VER_SERVICEPACKMINOR | VER_PLATFORMID;

    if (use_rtl) {
        using RtlVerifyVersionInfoFn = LONG (APIENTRY*) (OSVERSIONINFOEXW*, ULONG, ULONGLONG);
        HMODULE ntdll                = GetModuleHandleW (L"ntdll");
        if (!ntdll) {
            return false;
        }
        auto* fn = reinterpret_cast<RtlVerifyVersionInfoFn> (
        reinterpret_cast<void*> (GetProcAddress (ntdll, "RtlVerifyVersionInfo")));
        if (!fn) {
            return false;
        }
        return fn (&osver, type_mask, mask) == 0; // STATUS_SUCCESS
    }

// VerifyVersionInfoW carries a deprecation attribute whose whole message is
// "use the Version Helper APIs" - which are wrappers over this same call and
// would hide the exact behaviour under test. /WX would otherwise turn that
// advice into a build failure.
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4996)
#endif
    return VerifyVersionInfoW (&osver, type_mask, mask) != FALSE;
#ifdef _MSC_VER
#pragma warning(pop)
#endif
}

} // namespace

/**
 * On Windows, HTTP/2 used to live or die by this process's *reported* OS
 * version, and this is what keeps that from silently coming back.
 *
 * curl's Schannel backend enables ALPN only when the OS is at least Windows 8.1
 * (`s_win_has_alpn`, lib/vtls/schannel.c), and without ALPN a TLS connection
 * can never be anything but HTTP/1.1. That check prefers ntdll's
 * RtlVerifyVersionInfo, but resolves the pointer to it in Curl_win32_init(),
 * which libcurl's global_init() runs *after* Curl_ssl_init() - so the one call
 * that decided ALPN for the process fell back to VerifyVersionInfoW, which
 * reports Windows 8 (6.2) to any unmanifested process. 6.2 < 6.3, ALPN off,
 * HTTP/2 gone - silently, with a 200 and an httpVersion of "HTTP/1.1".
 *
 * So the invariant is not "the OS is new enough" but "this process is not being
 * lied to about it": the shimmed and unshimmed answers must agree. That holds
 * only while engine/res/vayu-windows.manifest is embedded in the binary, which
 * is what this actually guards.
 *
 * **Since #851 this build verifies with OpenSSL on Windows**, whose ALPN is not
 * gated on an OS version at all - so the chain above no longer runs and HTTP/2
 * here does not depend on the manifest. The assertion stays because it is what
 * makes a return to Schannel safe: the failure it catches is invisible, and a
 * backend change that silently re-armed it would ship an HTTP/1.1-only Windows
 * build reporting success. Whether the manifest is still earning its place for
 * any *other* reason is #856, not a deletion to make in passing.
 *
 * Scope: this proves it for vayu_tests. The binary that matters is
 * vayu-engine.exe, and no gtest can inspect a different executable - that half
 * is covered by .github/check-windows-deps.py, which scans the shipped artifact
 * for the same manifest. Both are wired up in engine/CMakeLists.txt via
 * vayu_embed_windows_manifest(); if you add a fourth executable that links
 * libcurl, call it there too.
 */
TEST (HttpVersionSupport, WindowsOsVersionIsNotShimmed) {
    const bool truth  = os_at_least (6, 3, /*use_rtl=*/true);
    const bool shimmed = os_at_least (6, 3, /*use_rtl=*/false);

    ASSERT_TRUE (truth) << "ntdll reports this OS as older than Windows 8.1, so "
                           "the shim below has nothing to hide and this test can "
                           "say nothing about the manifest - not a build defect.";

    EXPECT_TRUE (shimmed)
    << "This process is being version-shimmed: Windows tells it the OS is 6.2 "
       "while ntdll reports 6.3+.\n"
       "That means the supportedOS compatibility manifest is missing from this "
       "executable, and curl has silently disabled ALPN - every HTTPS request "
       "this binary makes is HTTP/1.1 no matter what httpVersion asks for "
       "(issue #215).\n"
       "Fix: engine/res/vayu-windows.manifest must reach this target via "
       "vayu_embed_windows_manifest() in engine/CMakeLists.txt.";
}

#else

// No non-Windows counterpart on purpose. Linux and macOS are both OpenSSL
// builds (#818 - this comment claimed Secure Transport for macOS until then),
// and OpenSSL's ALPN is not gated on an OS version check, so there is no
// equivalent way for it to switch itself off - the nghttp2 gate above is the
// whole precondition there.

#endif // _WIN32
