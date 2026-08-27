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

    ULONGLONG condition_mask = 0;
    condition_mask =
    VerSetConditionMask (condition_mask, VER_MAJORVERSION, VER_GREATER_EQUAL);
    condition_mask =
    VerSetConditionMask (condition_mask, VER_MINORVERSION, VER_GREATER_EQUAL);
    condition_mask =
    VerSetConditionMask (condition_mask, VER_SERVICEPACKMAJOR, VER_GREATER_EQUAL);
    condition_mask =
    VerSetConditionMask (condition_mask, VER_SERVICEPACKMINOR, VER_GREATER_EQUAL);
    condition_mask = VerSetConditionMask (condition_mask, VER_PLATFORMID, VER_EQUAL);

    const DWORD type_mask = VER_MAJORVERSION | VER_MINORVERSION |
    VER_SERVICEPACKMAJOR | VER_SERVICEPACKMINOR | VER_PLATFORMID;

    if (use_rtl) {
        using RtlVerifyVersionInfoFn =
        LONG (APIENTRY*) (OSVERSIONINFOEXW*, ULONG, ULONGLONG);
        HMODULE ntdll = GetModuleHandleW (L"ntdll");
        if (!ntdll) {
            return false;
        }
        // A function pointer off `GetProcAddress` is the cast `engine/CLAUDE.md`
        // names as having no primitive to route through - there is no
        // `byte_view`-shaped seam for "the address the loader returned is this
        // signature". Going through `void*` to soften it only added
        // `bugprone-casting-through-void`, whose own advice is this one cast.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        auto* fn = reinterpret_cast<RtlVerifyVersionInfoFn> (
        GetProcAddress (ntdll, "RtlVerifyVersionInfo"));
        if (!fn) {
            return false;
        }
        return fn (&osver, type_mask, condition_mask) == 0; // STATUS_SUCCESS
    }

// VerifyVersionInfoW carries a deprecation attribute whose whole message is
// "use the Version Helper APIs" - which are wrappers over this same call and
// would hide the exact behaviour under test. /WX would otherwise turn that
// advice into a build failure.
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4996)
#endif
    return VerifyVersionInfoW (&osver, type_mask, condition_mask) != FALSE;
#ifdef _MSC_VER
#pragma warning(pop)
#endif
}

} // namespace

/**
 * On Windows, HTTP/2 can live or die by this process's *reported* OS version,
 * and this is what keeps that from silently happening.
 *
 * curl's Schannel backend enables ALPN only when the OS is at least Windows 8.1
 * (`s_win_has_alpn`, lib/vtls/schannel.c:2620), and without ALPN a TLS
 * connection can never be anything but HTTP/1.1. That check prefers ntdll's
 * RtlVerifyVersionInfo, but resolves the pointer to it in Curl_win32_init(),
 * which libcurl's global_init() runs *after* Curl_ssl_init() - and
 * `s_win_has_alpn` is assigned inside schannel_init(), i.e. from within
 * Curl_ssl_init(). So the one call that decides ALPN for the process falls back
 * to VerifyVersionInfoW, which reports Windows 8 (6.2) to any unmanifested
 * process. 6.2 < 6.3, ALPN off, HTTP/2 gone - silently, with a 200 and an
 * httpVersion of "HTTP/1.1" (issue #215).
 *
 * So the invariant is not "the OS is new enough" but "this process is not being
 * lied to about it": the shimmed and unshimmed answers must agree. That holds
 * only while engine/res/vayu-windows.manifest is embedded in the binary, which
 * is what this actually guards.
 *
 * **Why it still matters after #851 put every leg on OpenSSL** (whose ALPN is
 * not gated on an OS version at all), which is the question #856 asked and
 * this is the answer to: Schannel is still compiled into the shipped libcurl.
 * The curl port's `http2` feature depends on `curl[ssl]`, which resolves to
 * Schannel on Windows, so the build is MultiSSL and getting it to one backend
 * is #858. This process runs on OpenSSL only because pin_tls_backend() names it
 * through curl_global_sslset before curl_global_init, and Curl_ssl_init() then
 * calls init() on the selected backend alone - so schannel_init() does not run.
 * That selection is a runtime call whose failure is deliberately non-fatal, so
 * the chain above is dormant rather than absent. **When #858 removes Schannel
 * from the build, this test, the manifest and check-windows-deps.py's manifest
 * check retire together** - that is the deletion condition, and it is not
 * satisfied yet.
 *
 * Both supportedOS ids the manifest ships are probed, because
 * check-windows-deps.py requires both on the shipped binary and a guard that
 * asserted only one would pass on half a manifest.
 *
 * Scope: this proves it for vayu_tests. The binary that matters is
 * vayu-engine.exe, and no gtest can inspect a different executable - that half
 * is covered by .github/check-windows-deps.py, which scans the shipped artifact
 * for the same manifest. Both are wired up via vayu_embed_windows_manifest() -
 * defined in engine/CMakeLists.txt, called there for vayu-engine and vayu-cli
 * and in engine/tests/CMakeLists.txt for this binary; if you add a fourth
 * executable that links libcurl, call it from wherever that target is defined.
 */
TEST (HttpVersionSupport, WindowsOsVersionIsNotShimmed) {
    const bool truth_81   = os_at_least (6, 3, /*use_rtl=*/true);
    const bool shimmed_81 = os_at_least (6, 3, /*use_rtl=*/false);

    ASSERT_TRUE (truth_81)
    << "ntdll reports this OS as older than Windows 8.1, so "
       "the shim below has nothing to hide and this test can "
       "say nothing about the manifest - not a build defect.";

    EXPECT_TRUE (shimmed_81)
    << "This process is being version-shimmed: Windows tells it the OS is 6.2 "
       "while ntdll reports 6.3+.\n"
       "That means the supportedOS compatibility manifest is missing from this "
       "executable. Schannel is still in this build (MultiSSL - see #858), and "
       "anything that puts the process on it gets ALPN silently disabled: "
       "every "
       "HTTPS request would be HTTP/1.1 no matter what httpVersion asks for "
       "(issue #215).\n"
       "Fix: engine/res/vayu-windows.manifest must reach this target via "
       "vayu_embed_windows_manifest() in engine/tests/CMakeLists.txt.";

    // The second id. The shim can only ever under-report, never over-report, so
    // equality is the exact statement "this process is not being lied to" - and
    // it stays true on a genuine Windows 8.1 host, where both answers are false.
    const bool truth_10   = os_at_least (10, 0, /*use_rtl=*/true);
    const bool shimmed_10 = os_at_least (10, 0, /*use_rtl=*/false);

    EXPECT_EQ (shimmed_10, truth_10)
    << "ntdll reports this OS as Windows 10 or later, but the shimmed API does "
       "not.\n"
       "If the 6.3 probe above passed, the manifest is present but incomplete: "
       "it is missing the Windows 10/11 supportedOS id "
       "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}, which caps what this process "
       "is "
       "told at 6.3.\n"
       "Nothing reads a shimmed version above 6.3 today (#856 enumerated "
       "them), "
       "so this is not a live defect - but the invariant this test exists for "
       "is "
       "that the reported version is the real one, and "
       ".github/check-windows-deps.py requires this id on the shipped binary. "
       "Half a manifest here and a full one there is the drift both guards are "
       "meant to catch.\n"
       "Fix: restore the id in engine/res/vayu-windows.manifest.";
}

#else

// No non-Windows counterpart on purpose. Linux and macOS are both OpenSSL
// builds (#818 - this comment claimed Secure Transport for macOS until then),
// and OpenSSL's ALPN is not gated on an OS version check, so there is no
// equivalent way for it to switch itself off - the nghttp2 gate above is the
// whole precondition there.

#endif // _WIN32
