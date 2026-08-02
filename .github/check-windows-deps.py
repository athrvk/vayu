#!/usr/bin/env python3
"""Fail the build if the shipped Windows engine cannot run correctly on a user's box.

Two checks, both on the actual artifact rather than on the build settings that
were supposed to produce it - each one exists because a release shipped broken
in a way CI could not see.

1. Imports. v0.10.0 and v0.11.0 both shipped a `vayu-engine.exe` that imported
MSVCP140.dll / VCRUNTIME140.dll - the Visual C++ redistributable, which is NOT
part of a clean Windows install and was not bundled in the installer. On any
machine without the redist (a fresh VM, the winget validation sandbox, a user
who has never installed a C++ app) Windows refused to load the binary, the
sidecar died the instant Electron spawned it, and the UI sat on "Disconnected"
with no explanation.

Nothing caught it because CI builds and tests the engine on a runner that
already has the redist, and the packaged artifact is never run anywhere.

The engine is now statically linked (VCPKG_TARGET_TRIPLET=x64-windows-static
plus a static MSVC runtime), so a correct build imports *only* DLLs that ship
with Windows itself. That makes the check below exact rather than heuristic:
any import outside the allowlist means something got linked dynamically again -
a flipped triplet, a new dependency, a vendored target that missed CMP0091 -
and it would ship broken. Allowlisting the OS rather than denylisting the CRT
is deliberate: it catches dependencies nobody has thought of yet.

2. The `supportedOS` compatibility manifest. Without it Windows reports itself
as 6.2 to the process, curl's Schannel backend concludes the OS predates ALPN,
and every HTTPS request goes out as HTTP/1.1 however loudly the user asks for
h2 - a 200, no error, no warning (issue #215). v0.11.0 through v0.14.0 shipped
with HTTP/2 dead on Windows for exactly this reason. `engine/CMakeLists.txt`
embeds it via `vayu_embed_windows_manifest()`, and `vayu_tests` asserts its own
copy in `HttpVersionSupport.WindowsOsVersionIsNotShimmed` - but a gtest can only
vouch for the binary it is running in, and the binary users get is this one.

Usage:
    python .github/check-windows-deps.py <path-to-exe-or-dll>
"""

import sys

try:
    import pefile
except ImportError:  # pragma: no cover - CI installs this, keep the hint useful
    print("error: pefile is required (pip install pefile)", file=sys.stderr)
    sys.exit(2)

# DLLs that ship with Windows 10/11 itself. The `api-ms-win-*` families are the
# Universal CRT and the API sets - part of the OS since Windows 10, unlike
# MSVCP140/VCRUNTIME140, which come from the redistributable.
ALLOWED_EXACT = {
    # Core
    "kernel32.dll", "kernelbase.dll", "ntdll.dll", "rpcrt4.dll",
    "advapi32.dll", "user32.dll", "gdi32.dll", "version.dll", "psapi.dll",
    "shell32.dll", "shlwapi.dll", "ole32.dll", "oleaut32.dll", "combase.dll",
    "userenv.dll", "imm32.dll", "comdlg32.dll", "comctl32.dll", "setupapi.dll",
    "cfgmgr32.dll", "powrprof.dll", "winmm.dll", "dbghelp.dll", "normaliz.dll",
    # Networking
    "ws2_32.dll", "wsock32.dll", "iphlpapi.dll", "mswsock.dll", "dnsapi.dll",
    "winhttp.dll", "wininet.dll", "netapi32.dll",
    # Crypto / TLS (curl uses Schannel on Windows)
    "crypt32.dll", "bcrypt.dll", "ncrypt.dll", "secur32.dll", "sspicli.dll",
    "wintrust.dll",
}

ALLOWED_PREFIXES = ("api-ms-win-", "ext-ms-win-")

# Named purely to make the failure message actionable.
REDIST_PREFIXES = ("msvcp", "vcruntime", "concrt", "msvcr")

# RT_MANIFEST. The application manifest is a resource, not an import, so it is
# invisible to the check above - a binary can pass that one and still have
# HTTP/2 switched off.
RT_MANIFEST = 24

# supportedOS ids that must appear in it. The 8.1 id is the one HTTP/2 hangs
# on: curl's Schannel ALPN gate asks for >= 6.3, and an unmanifested process is
# told 6.2. The 10/11 id is what makes the reported version the real one on a
# modern box, which curl's other version gates (e.g. the >= 6.1 check that
# allows a CA bundle) read the same way.
REQUIRED_SUPPORTED_OS = {
    "{1f676c76-80e1-4239-95bb-83d0f6d0da78}": (
        "Windows 8.1 - clears curl's Schannel ALPN gate. Without it every "
        "HTTPS request is HTTP/1.1, silently."
    ),
    "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}": (
        "Windows 10/11 - makes the OS version reported to the process the "
        "real one, which curl's other version gates also read."
    ),
}


def is_allowed(dll: str) -> bool:
    name = dll.lower()
    return name in ALLOWED_EXACT or name.startswith(ALLOWED_PREFIXES)


def imported_dlls(path: str) -> list[str]:
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]]
    )
    entries = getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) or []
    return sorted({e.dll.decode("utf-8", "replace") for e in entries if e.dll})


def embedded_manifest(path: str) -> str | None:
    """The RT_MANIFEST resource embedded in the binary, or None if it has none."""
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]]
    )
    root = getattr(pe, "DIRECTORY_ENTRY_RESOURCE", None)
    if root is None:
        return None
    for type_entry in root.entries:
        if getattr(type_entry, "id", None) != RT_MANIFEST:
            continue
        for name_entry in getattr(type_entry.directory, "entries", []):
            for lang_entry in getattr(name_entry.directory, "entries", []):
                data = pe.get_data(
                    lang_entry.data.struct.OffsetToData, lang_entry.data.struct.Size
                )
                return data.decode("utf-8", "replace")
    return None


def check_manifest(path: str) -> int:
    manifest = embedded_manifest(path)
    if manifest is None:
        print(
            f"\nFAILED: {path} has no embedded application manifest.\n"
            "  Windows will report itself as 6.2 to this process, curl's Schannel\n"
            "  backend will disable ALPN, and every HTTPS request will be HTTP/1.1\n"
            "  regardless of the requested httpVersion - with a 200 and no error.\n"
            "  Fix: vayu_embed_windows_manifest() in engine/CMakeLists.txt must be\n"
            "  called for this target (engine/res/vayu-windows.manifest).",
            file=sys.stderr,
        )
        return 1

    lowered = manifest.lower()
    missing = [
        (guid, why) for guid, why in REQUIRED_SUPPORTED_OS.items() if guid not in lowered
    ]

    print("\nApplication manifest:")
    for guid, _ in REQUIRED_SUPPORTED_OS.items():
        print(f"  {'FAIL' if guid in dict(missing) else 'ok  '}  supportedOS {guid}")

    if missing:
        print(
            f"\nFAILED: {len(missing)} required supportedOS id(s) missing from the "
            "manifest of\n"
            f"  {path}. See engine/res/vayu-windows.manifest.",
            file=sys.stderr,
        )
        for guid, why in missing:
            print(f"\n  {guid}\n    {why}", file=sys.stderr)
        return 1

    print("\nOK: the supportedOS manifest is embedded - ALPN, and so HTTP/2, work.")
    return 0


def check_imports(path: str) -> int:
    dlls = imported_dlls(path)
    if not dlls:
        # An import table we failed to read would make this check vacuously
        # green - exactly the "guard that scanned an empty string" failure
        # mode CLAUDE.md warns about. Treat it as a failure.
        print(f"error: no imports found in {path} - the check cannot vouch for it",
              file=sys.stderr)
        return 1

    violations = [d for d in dlls if not is_allowed(d)]

    print(f"Imports of {path} ({len(dlls)} DLLs):")
    for d in dlls:
        print(f"  {'FAIL' if d in violations else 'ok  '}  {d}")

    if not violations:
        print("\nOK: every import ships with Windows - no redistributable needed.")
        return 0


    redist = [d for d in violations if d.lower().startswith(REDIST_PREFIXES)]
    others = [d for d in violations if d not in redist]

    print(f"\nFAILED: {len(violations)} import(s) do not ship with Windows.",
          file=sys.stderr)
    if redist:
        print(
            "\n  Visual C++ redistributable: " + ", ".join(redist) +
            "\n  The engine is linking the MSVC runtime dynamically. Users without"
            "\n  the redist cannot start it and the app shows 'Disconnected'."
            "\n  Check CMAKE_MSVC_RUNTIME_LIBRARY and that CMP0091 is NEW for every"
            "\n  target, including vendored subdirectories.",
            file=sys.stderr,
        )
    if others:
        print(
            "\n  Third-party DLLs: " + ", ".join(others) +
            "\n  These would have to be shipped beside the binary. Prefer building"
            "\n  them statically (VCPKG_TARGET_TRIPLET=x64-windows-static).",
            file=sys.stderr,
        )
    return 1


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    path = sys.argv[1]
    # Both checks always run - a binary that fails one and passes the other
    # should report both, or the second failure only surfaces after the first
    # is fixed and re-run.
    return max(check_imports(path), check_manifest(path))


if __name__ == "__main__":
    sys.exit(main())
