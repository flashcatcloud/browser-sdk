#!/usr/bin/env bash
# Cut one version's section out of a CHANGELOG and write it as GitHub Release notes.
#
# Fail-closed by design: if the version has no section, the section appears more than once,
# or the section has no content, this exits non-zero and writes nothing. A release job runs
# it BEFORE anything is published, so a release can never go out without readable notes.
#
# Usage: extract-release-notes.sh --changelog FILE --version X.Y.Z --level N --output FILE [--public-only]
#
#   --level N       heading level of a version heading (1 = "# 1.2.0 / date", 2 = "## v1.2.0", "## [1.2.0] - date").
#                   The section ends at the next heading of level <= N.
#   --public-only   keep only the part before a "**Internal Changes:**" label, and drop the
#                   "**Public Changes:**" label line itself.
#
# The notes are the section body: everything under the version heading, without the heading,
# with leading/trailing blank lines and trailing "---" separators removed. A "v" prefix and
# surrounding "[...]" on the heading's version are ignored; the version itself is compared literally.
set -euo pipefail

changelog="" version="" level="" output="" public_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --changelog) changelog="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --level) level="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --public-only) public_only=1; shift ;;
    *) echo "::error::unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "::error::$*" >&2; exit 1; }

[ -n "$changelog" ] && [ -n "$version" ] && [ -n "$level" ] && [ -n "$output" ] \
  || fail "usage: extract-release-notes.sh --changelog FILE --version X.Y.Z --level N --output FILE [--public-only]"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)*$ ]] || fail "not a valid version: '$version'"
case "$level" in 1|2|3) ;; *) fail "--level must be 1, 2 or 3" ;; esac
[ -f "$changelog" ] || fail "$changelog does not exist"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# awk prints "COUNT <n>" on the first line, then the raw section lines.
awk -v want="$version" -v level="$level" '
  function heading_level(line,   n) {
    n = match(line, /^#+ /)
    return n ? RLENGTH - 1 : 0
  }
  function heading_version(line,   v) {
    v = line
    sub(/^#+ +/, "", v)
    sub(/^\[/, "", v)
    sub(/^v/, "", v)
    sub(/[] \t].*$/, "", v)
    return v
  }
  { sub(/\r$/, "") }
  /^```/ { infence = !infence }
  {
    hl = infence ? 0 : heading_level($0)
    if (hl > 0 && hl <= level) {
      insec = 0
      if (hl == level && heading_version($0) == want) { insec = 1; count++; next }
    }
    if (insec) body = body $0 "\n"
  }
  END { printf "COUNT %d\n%s", count + 0, body }
' "$changelog" > "$tmp"

count="$(head -n 1 "$tmp" | sed 's/^COUNT //')"
[ "$count" -ne 0 ] || fail "$changelog has no section for version $version. Add a heading for $version with the release notes, then re-run."
[ "$count" -eq 1 ] || fail "$changelog has $count sections for version $version; keep exactly one."

body="$(tail -n +2 "$tmp")"

if [ "$public_only" -eq 1 ]; then
  body="$(printf '%s\n' "$body" | awk '
    /^\*\*Internal Changes:\*\*[ \t]*$/ { exit }
    /^\*\*Public Changes:\*\*[ \t]*$/ { next }
    { print }
  ')"
fi

# Trim leading/trailing blank lines and trailing "---" separators.
body="$(printf '%s\n' "$body" | awk '
  { lines[NR] = $0 }
  END {
    s = 1; e = NR
    while (s <= e && lines[s] ~ /^[ \t]*$/) s++
    while (e >= s && (lines[e] ~ /^[ \t]*$/ || lines[e] ~ /^---+[ \t]*$/)) e--
    for (i = s; i <= e; i++) print lines[i]
  }
')"

if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
  fail "$changelog has a section for $version but it has no release notes. Write them (user-facing changes) before releasing."
fi

printf '%s\n' "$body" > "$output"
echo "Release notes for $version: $(wc -l < "$output" | tr -d ' ') lines from $changelog"
