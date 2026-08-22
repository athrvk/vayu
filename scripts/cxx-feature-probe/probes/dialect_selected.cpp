// Not a feature probe - the harness's own self-check, kept out of the report.
//
// Every verdict in the table is worthless if the standard did not actually
// reach the compiler, so this asserts that the selected dialect is newer than
// C++20 before any feature is measured. It asserts "newer than C++20" rather
// than the C++23 value on purpose: GCC 13 reports __cplusplus as 202100L at
// -std=c++23 and MSVC reports _MSVC_LANG as 202004L at /std:c++latest, while a
// dialect that never got applied leaves the compiler default (C++17 for GCC
// 13) in place - which is the only case this has to catch.
#if defined(_MSVC_LANG)
static_assert (_MSVC_LANG > 202002L, "the probed dialect was not applied");
#else
static_assert (__cplusplus > 202002L, "the probed dialect was not applied");
#endif

int main () { return 0; }
