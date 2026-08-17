#!/usr/bin/env bash
set -euo pipefail

umask 077

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
MTLS_ROOT="${HARNESS_MTLS_DIR:-${DATA_HOME}/cursor-harness-bridge/mtls}"
CA_DIR="${MTLS_ROOT}/ca"
CA_PRIVATE_DIR="${CA_DIR}/private"
CA_NEW_CERTS_DIR="${CA_DIR}/newcerts"
PUBLIC_DIR="${MTLS_ROOT}/public"
CLIENTS_DIR="${MTLS_ROOT}/clients"
OPENSSL_CONFIG="${CA_DIR}/openssl.cnf"
CA_KEY="${CA_PRIVATE_DIR}/ca.key"
CA_CERT="${CA_DIR}/ca.crt"
CA_NAME_FILE="${CA_DIR}/ca-common-name"
PUBLIC_CA_CERT="${PUBLIC_DIR}/ca.crt"
PUBLIC_CRL="${PUBLIC_DIR}/ca.crl"
NGINX_CONTAINER="${NGINX_CONTAINER:-}"
CA_ORGANIZATION="${HARNESS_CA_ORGANIZATION:-Cursor Harness}"
CA_COMMON_NAME="${HARNESS_CA_COMMON_NAME:-}"

usage() {
  cat <<'EOF'
Usage:
  harness-mtls.sh init
  harness-mtls.sh issue <device-name>
  harness-mtls.sh revoke <device-name>
  harness-mtls.sh refresh-crl
  harness-mtls.sh list

Environment:
  HARNESS_MTLS_DIR          Certificate state root
                            (default: $XDG_DATA_HOME/cursor-harness-bridge/mtls)
  HARNESS_CA_ORGANIZATION   Certificate subject organization
  HARNESS_CA_COMMON_NAME    Unique CA name; generated and persisted by default
  NGINX_CONTAINER           Optional Nginx container to validate and reload
EOF
}

require_openssl() {
  command -v openssl >/dev/null 2>&1 || {
    echo "openssl is required" >&2
    exit 1
  }
}

validate_device_name() {
  local device="${1:-}"
  if [[ ! "${device}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    echo "Invalid device name: use 1-64 letters, digits, dot, underscore, or dash" >&2
    exit 2
  fi
}

validate_ca_organization() {
  if [[ ! "${CA_ORGANIZATION}" =~ ^[A-Za-z0-9._\ -]{1,64}$ ]]; then
    echo "HARNESS_CA_ORGANIZATION contains unsupported characters" >&2
    exit 2
  fi
}

validate_ca_common_name() {
  if [[ ! "${CA_COMMON_NAME}" =~ ^[A-Za-z0-9._\ -]{1,96}$ ]]; then
    echo "HARNESS_CA_COMMON_NAME contains unsupported characters" >&2
    exit 2
  fi
}

certificate_common_name() {
  openssl x509 \
    -in "${CA_CERT}" \
    -noout \
    -subject \
    -nameopt multiline |
    awk -F'= ' '/commonName/{print $2; exit}'
}

resolve_ca_common_name() {
  local requested="${CA_COMMON_NAME}"
  local persisted=""
  local existing=""
  [[ -f "${CA_NAME_FILE}" ]] && persisted="$(<"${CA_NAME_FILE}")"
  [[ -f "${CA_CERT}" ]] && existing="$(certificate_common_name)"

  if [[ -n "${requested}" ]]; then
    CA_COMMON_NAME="${requested}"
  elif [[ -n "${existing}" ]]; then
    # Existing certificates are authoritative during upgrades: changing their
    # DN would invalidate every issued client certificate.
    CA_COMMON_NAME="${existing}"
  elif [[ -n "${persisted}" ]]; then
    CA_COMMON_NAME="${persisted}"
  else
    CA_COMMON_NAME="Cursor Harness Client CA $(openssl rand -hex 16)"
  fi
  validate_ca_common_name

  if [[ -n "${existing}" && "${existing}" != "${CA_COMMON_NAME}" ]]; then
    echo "Configured CA name does not match existing certificate: ${existing}" >&2
    exit 1
  fi
  if [[ -n "${persisted}" && "${persisted}" != "${CA_COMMON_NAME}" ]]; then
    echo "Persisted CA name does not match resolved name: ${persisted}" >&2
    exit 1
  fi
  printf '%s\n' "${CA_COMMON_NAME}" >"${CA_NAME_FILE}"
  chmod 600 "${CA_NAME_FILE}"
}

write_openssl_config() {
  cat >"${OPENSSL_CONFIG}" <<EOF
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = ${CA_DIR}
database          = \$dir/index.txt
new_certs_dir     = \$dir/newcerts
certificate       = \$dir/ca.crt
private_key       = \$dir/private/ca.key
serial            = \$dir/serial
crlnumber         = \$dir/crlnumber
default_md        = sha256
default_days      = 825
default_crl_days  = 365
unique_subject    = no
copy_extensions   = none
policy            = policy_client

[ policy_client ]
commonName              = supplied
organizationName        = optional
organizationalUnitName  = optional
countryName             = optional
stateOrProvinceName     = optional
localityName            = optional
emailAddress            = optional

[ req ]
prompt              = no
distinguished_name  = ca_dn
x509_extensions     = v3_ca
default_md          = sha256

[ ca_dn ]
CN = ${CA_COMMON_NAME}
O  = ${CA_ORGANIZATION}

[ v3_ca ]
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints       = critical,CA:true,pathlen:0
keyUsage               = critical,keyCertSign,cRLSign

[ client_cert ]
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature,keyEncipherment
extendedKeyUsage       = clientAuth
EOF
  chmod 600 "${OPENSSL_CONFIG}"
}

publish_ca() {
  install -m 0644 "${CA_CERT}" "${PUBLIC_CA_CERT}"
}

generate_crl() {
  local temp_crl="${PUBLIC_DIR}/.ca.crl.$$"
  openssl ca \
    -batch \
    -config "${OPENSSL_CONFIG}" \
    -gencrl \
    -out "${temp_crl}" >/dev/null 2>&1
  chmod 644 "${temp_crl}"
  mv -f "${temp_crl}" "${PUBLIC_CRL}"
}

init_ca() {
  require_openssl
  install -d -m 0700 "${MTLS_ROOT}" "${CA_DIR}" "${CA_PRIVATE_DIR}" "${CLIENTS_DIR}"
  install -d -m 0700 "${CA_NEW_CERTS_DIR}"
  install -d -m 0755 "${PUBLIC_DIR}"
  resolve_ca_common_name
  write_openssl_config

  if [[ ! -f "${CA_KEY}" || ! -f "${CA_CERT}" ]]; then
    if [[ -e "${CA_KEY}" || -e "${CA_CERT}" ]]; then
      echo "Incomplete CA state under ${CA_DIR}; refusing to overwrite it" >&2
      exit 1
    fi
    openssl genrsa -out "${CA_KEY}" 4096 >/dev/null 2>&1
    chmod 600 "${CA_KEY}"
    openssl req \
      -new \
      -x509 \
      -config "${OPENSSL_CONFIG}" \
      -key "${CA_KEY}" \
      -extensions v3_ca \
      -days 3650 \
      -out "${CA_CERT}" >/dev/null 2>&1
    chmod 644 "${CA_CERT}"
    : >"${CA_DIR}/index.txt"
    echo 1000 >"${CA_DIR}/serial"
    echo 1000 >"${CA_DIR}/crlnumber"
  fi

  touch "${CA_DIR}/index.txt"
  [[ -s "${CA_DIR}/serial" ]] || echo 1000 >"${CA_DIR}/serial"
  [[ -s "${CA_DIR}/crlnumber" ]] || echo 1000 >"${CA_DIR}/crlnumber"
  publish_ca
  generate_crl
  echo "Harness client CA is ready under ${MTLS_ROOT}"
  echo "  acceptable issuer: ${CA_COMMON_NAME}"
}

ensure_ca() {
  if [[ ! -f "${CA_KEY}" || ! -f "${CA_CERT}" || ! -f "${OPENSSL_CONFIG}" ]]; then
    init_ca
  else
    require_openssl
    resolve_ca_common_name
  fi
}

issue_client() {
  local device="$1"
  validate_device_name "${device}"
  ensure_ca

  local device_dir="${CLIENTS_DIR}/${device}"
  local key="${device_dir}/client.key"
  local csr="${device_dir}/client.csr"
  local cert="${device_dir}/client.crt"
  local bundle="${device_dir}/${device}.p12"
  local password_file="${device_dir}/password.txt"

  if [[ -e "${device_dir}" ]]; then
    echo "Client directory already exists: ${device_dir}" >&2
    echo "Use a new device name, or revoke the existing certificate first." >&2
    exit 1
  fi

  install -d -m 0700 "${device_dir}"
  openssl genrsa -out "${key}" 3072 >/dev/null 2>&1
  openssl req \
    -new \
    -sha256 \
    -key "${key}" \
    -subj "/CN=harness-client-${device}/O=${CA_ORGANIZATION}/OU=Harness Clients" \
    -out "${csr}" >/dev/null 2>&1
  openssl ca \
    -batch \
    -config "${OPENSSL_CONFIG}" \
    -extensions client_cert \
    -days 825 \
    -notext \
    -in "${csr}" \
    -out "${cert}" >/dev/null 2>&1

  local password
  password="$(openssl rand -hex 18)"
  printf '%s\n' "${password}" >"${password_file}"
  openssl pkcs12 \
    -export \
    -name "${CA_COMMON_NAME} - ${device}" \
    -inkey "${key}" \
    -in "${cert}" \
    -certfile "${CA_CERT}" \
    -passout "pass:${password}" \
    -out "${bundle}" >/dev/null 2>&1

  chmod 600 "${key}" "${csr}" "${cert}" "${bundle}" "${password_file}"
  openssl verify -purpose sslclient -CAfile "${CA_CERT}" "${cert}" >/dev/null
  echo "Issued ${device}:"
  echo "  package:  ${bundle}"
  echo "  password: ${password_file}"
}

reload_nginx() {
  if [[ -z "${NGINX_CONTAINER}" ]]; then
    echo "NGINX_CONTAINER is unset; reload your TLS proxy after CRL changes." >&2
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is unavailable; reload Nginx manually after updating the CRL." >&2
    return
  fi
  if ! docker inspect "${NGINX_CONTAINER}" >/dev/null 2>&1; then
    echo "Nginx container ${NGINX_CONTAINER} is not running; skipping reload." >&2
    return
  fi
  docker exec "${NGINX_CONTAINER}" nginx -t >/dev/null
  docker exec "${NGINX_CONTAINER}" nginx -s reload
}

revoke_client() {
  local device="$1"
  validate_device_name "${device}"
  ensure_ca

  local device_dir="${CLIENTS_DIR}/${device}"
  local cert="${device_dir}/client.crt"
  if [[ ! -f "${cert}" ]]; then
    echo "Certificate not found: ${cert}" >&2
    exit 1
  fi
  if [[ -f "${device_dir}/revoked-at.txt" ]]; then
    echo "${device} is already revoked"
    exit 0
  fi

  openssl ca \
    -batch \
    -config "${OPENSSL_CONFIG}" \
    -revoke "${cert}" \
    -crl_reason cessationOfOperation >/dev/null 2>&1
  generate_crl
  date -u +'%Y-%m-%dT%H:%M:%SZ' >"${device_dir}/revoked-at.txt"
  chmod 600 "${device_dir}/revoked-at.txt"
  reload_nginx
  echo "Revoked ${device}; CRL updated at ${PUBLIC_CRL}"
}

list_clients() {
  ensure_ca
  awk -F '\t' '
    BEGIN {
      printf "%-10s %-12s %-16s %s\n", "STATUS", "SERIAL", "EXPIRES", "SUBJECT"
    }
    {
      label = $1
      if ($1 == "V") label = "VALID"
      else if ($1 == "R") label = "REVOKED"
      else if ($1 == "E") label = "EXPIRED"
      printf "%-10s %-12s %-16s %s\n", label, $4, $2, $6
    }
  ' "${CA_DIR}/index.txt"
}

main() {
  validate_ca_organization
  local command="${1:-}"
  case "${command}" in
    init)
      init_ca
      ;;
    issue)
      [[ $# -eq 2 ]] || { usage >&2; exit 2; }
      issue_client "$2"
      ;;
    revoke)
      [[ $# -eq 2 ]] || { usage >&2; exit 2; }
      revoke_client "$2"
      ;;
    refresh-crl)
      ensure_ca
      generate_crl
      reload_nginx
      echo "CRL refreshed: ${PUBLIC_CRL}"
      ;;
    list)
      list_clients
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
