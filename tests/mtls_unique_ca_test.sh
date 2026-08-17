#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

first="${TMP}/first"
second="${TMP}/second"
named="${TMP}/named"

HARNESS_MTLS_DIR="${first}" "${ROOT}/scripts/harness-mtls.sh" init >/dev/null
HARNESS_MTLS_DIR="${second}" "${ROOT}/scripts/harness-mtls.sh" init >/dev/null

first_name="$(<"${first}/ca/ca-common-name")"
second_name="$(<"${second}/ca/ca-common-name")"
test -n "${first_name}"
test -n "${second_name}"
test "${first_name}" != "${second_name}"

first_subject_before="$(
  openssl x509 -in "${first}/ca/ca.crt" -noout -subject -nameopt RFC2253
)"
HARNESS_MTLS_DIR="${first}" "${ROOT}/scripts/harness-mtls.sh" init >/dev/null
first_subject_after="$(
  openssl x509 -in "${first}/ca/ca.crt" -noout -subject -nameopt RFC2253
)"
test "${first_subject_before}" = "${first_subject_after}"
test "$(<"${first}/ca/ca-common-name")" = "${first_name}"

HARNESS_MTLS_DIR="${named}" \
HARNESS_CA_COMMON_NAME="Example Production Harness CA" \
  "${ROOT}/scripts/harness-mtls.sh" init >/dev/null
named_subject="$(
  openssl x509 -in "${named}/ca/ca.crt" -noout -subject -nameopt RFC2253
)"
case "${named_subject}" in
  *"CN=Example Production Harness CA"*) ;;
  *)
    echo "Explicit CA common name missing from subject: ${named_subject}" >&2
    exit 1
    ;;
esac

echo "MTLS_UNIQUE_CA_OK"
