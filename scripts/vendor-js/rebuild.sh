#!/usr/bin/env bash
# Rebuild one vendored script library from its npm tarballs and prove the
# committed file is what the manifest says it is (#2750).
#
#   scripts/vendor-js/rebuild.sh <lib>      e.g. chai, tv4, xml2js
#
# Reads engine/vendor/js-manifest.json for the library, fetches every tarball
# it lists, checks each against its registry dist.integrity, then produces the
# file the manifest's build entry describes: copied byte for byte out of the
# package ("verbatim"), or the esbuild command the entry pins. The output's
# SHA-256 is compared with the manifest's. Needs network, node/npm (esbuild
# is installed from the registry at the pinned version), curl, tar and
# openssl. Not run in CI: the offline half of the proof is the VendorJsManifest
# ctest suite.
#
# Exit status: 0 the rebuild matches the manifest, 1 it does not (the output
# is left in the directory named on stderr, for an upgrade to copy from),
# 2 usage or a tooling/integrity failure.

set -euo pipefail

die() {
  echo "rebuild.sh: $*" >&2
  exit 2
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The registry's dist.integrity spelling: "sha512-" and the base64 digest.
integrity_of() {
  printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"
}

[ $# -eq 1 ] || die "usage: rebuild.sh <lib>   (a name from engine/vendor/js-manifest.json)"
lib=$1

for tool in node npm curl tar openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

here=$(cd "$(dirname "$0")" && pwd)
vendor=$(cd "$here/../../engine/vendor" && pwd)
manifest=$vendor/js-manifest.json
[ -f "$manifest" ] || die "$manifest not found"

# One tab-separated line per fact, so bash never parses JSON.
plan=$(node -e '
const [file, lib] = process.argv.slice(1);
const manifest = JSON.parse(require("fs").readFileSync(file, "utf8"));
const entry = manifest.files.find((f) => f.name === lib);
if (!entry) {
  console.error("unknown library \"" + lib + "\"; the manifest lists: " +
    manifest.files.map((f) => f.name).join(", "));
  process.exit(2);
}
const out = [["file", entry.path, entry.sha256]];
for (const p of entry.packages) {
  out.push(["package", p.name, p.version, p.tarball, p.integrity]);
}
const build = entry.build;
out.push(["kind", build.kind]);
if (build.kind === "verbatim") out.push(["source", build.source]);
if (build.kind === "esbuild") {
  out.push(["esbuild", build.esbuild]);
  for (const a of build.args) out.push(["arg", a]);
}
for (const line of out) console.log(line.join("\t"));
' "$manifest" "$lib") || exit 2

path="" want="" kind="" source="" esbuild_version=""
names=() versions=() tarballs=() integrities=() args=()
while IFS=$'\t' read -r tag a b c d; do
  case $tag in
    file) path=$a want=$b ;;
    package) names+=("$a"); versions+=("$b"); tarballs+=("$c"); integrities+=("$d") ;;
    kind) kind=$a ;;
    source) source=$a ;;
    esbuild) esbuild_version=$a ;;
    arg) args+=("$a") ;;
  esac
done <<<"$plan"

work=$(mktemp -d "${TMPDIR:-/tmp}/vayu-vendor-js.XXXXXX")
cleanup=1
trap 'if [ "$cleanup" -eq 1 ]; then rm -rf "$work"; fi' EXIT
mkdir -p "$work/node_modules" "$work/out"

# esbuild first: `npm install` prunes anything under node_modules that is not
# in its tree, so it must not run after the tarballs are extracted.
if [ "$kind" = esbuild ]; then
  npm install --silent --no-save --no-audit --no-fund --ignore-scripts \
    --prefix "$work" "esbuild@$esbuild_version" >/dev/null ||
    die "could not install esbuild@$esbuild_version"
  [ "$("$work/node_modules/.bin/esbuild" --version)" = "$esbuild_version" ] ||
    die "installed esbuild is not $esbuild_version"
fi

# The package under node_modules/<name> is the tarball's package/ directory,
# which is the layout the build commands name. Fetching by URL and checking the
# integrity replaces `npm install`'s resolution, so no copy of a dependency can
# be a version the manifest did not name.
i=0
while [ "$i" -lt "${#names[@]}" ]; do
  name=${names[$i]}
  echo "fetching ${tarballs[$i]}"
  curl -fsSL --retry 3 -o "$work/$i.tgz" "${tarballs[$i]}" || die "download failed: ${tarballs[$i]}"
  got=$(integrity_of "$work/$i.tgz")
  [ "$got" = "${integrities[$i]}" ] ||
    die "integrity mismatch for $name@${versions[$i]}: manifest ${integrities[$i]}, tarball $got"
  mkdir -p "$work/node_modules/$name"
  tar -xzf "$work/$i.tgz" -C "$work/node_modules/$name" --strip-components=1
  i=$((i + 1))
done

out=$work/out/$(basename "$path")

case $kind in
  verbatim)
    cp "$work/node_modules/${names[0]}/$source" "$out"
    ;;
  esbuild)
    esbuild_bin=$work/node_modules/.bin/esbuild
    resolved=()
    for arg in "${args[@]}"; do
      arg=${arg//\{vendor\}/$vendor}
      resolved+=("${arg//\{out\}/$out}")
    done
    (cd "$work" && "$esbuild_bin" "${resolved[@]}") || die "esbuild failed"
    ;;
  *) die "unknown build kind \"$kind\"" ;;
esac

[ -f "$out" ] || die "the build produced no $out"
got=$(sha256_of "$out")
if [ "$got" = "$want" ]; then
  echo "$lib: $path rebuilds byte for byte (sha256 $got)"
  exit 0
fi

cleanup=0
echo "$lib: rebuilt $path does not match the manifest" >&2
echo "  manifest: $want" >&2
echo "  rebuilt:  $got" >&2
echo "  output kept at $out" >&2
exit 1
