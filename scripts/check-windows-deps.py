#!/usr/bin/env python3
"""Fail the build if the Windows engine imports anything Windows does not ship.

Context: v0.10.0 and v0.11.0 both shipped a `vayu-engine.exe` that imported
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

Usage:
    python scripts/check-windows-deps.py <path-to-exe-or-dll>
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


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    path = sys.argv[1]
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


if __name__ == "__main__":
    sys.exit(main())
