# picosha2 (vendored)

Single-header SHA-256, used by the engine for PKCE (RFC 7636 S256) code
challenges so we neither hand-maintain a hash implementation nor link OpenSSL.

- **Upstream:** https://github.com/okdshin/PicoSHA2
- **File:** `picosha2.h` (version tag `picosha2:20140213`)
- **License:** MIT (full text is embedded at the top of `picosha2.h`)

Vendored verbatim — do not edit locally. To update, replace `picosha2.h` with a
newer upstream copy. Correctness is pinned by the FIPS 180-4 and RFC 7636
Appendix B vectors in `engine/tests/pkce_test.cpp`.
