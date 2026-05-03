#!/usr/bin/env bash
# Uso: openapi-show-endpoint.sh <path-or-substring>
# Extrae solo el fragmento del endpoint relevante de docs/api/openapi.yaml en
# vez de imprimir el archivo completo. Util cuando el issue afecta a un
# endpoint puntual y el agente solo necesita el contrato de ese path.
#
# Ejemplos:
#   openapi-show-endpoint.sh /signin
#   openapi-show-endpoint.sh profile

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <path-or-substring>" >&2
  exit 2
fi

NEEDLE="$1"

cd "$(dirname "$0")/../.."

SPEC="docs/api/openapi.yaml"
if [[ ! -f "$SPEC" ]]; then
  echo "ERROR: spec OpenAPI no encontrada en ${SPEC}" >&2
  exit 1
fi

# Encuentra el numero de linea del path que matchea el needle dentro de la
# seccion paths:. Imprime desde esa linea hasta el siguiente path (o EOF).
LINE=$(awk -v n="$NEEDLE" '
  /^paths:/ { in_paths=1; next }
  in_paths && /^[a-zA-Z]/ && !/^  / { in_paths=0 }
  in_paths && /^  \// && index($0, n) { print NR; exit }
' "$SPEC")

if [[ -z "$LINE" ]]; then
  echo "ERROR: no se encontro endpoint con substring '${NEEDLE}' en ${SPEC}" >&2
  echo "Endpoints disponibles:"
  awk '/^paths:/{p=1;next} p && /^[a-zA-Z]/ && !/^  /{p=0} p && /^  \//{print "  "$1}' "$SPEC" | sort -u
  exit 1
fi

# Imprime desde la linea encontrada hasta el siguiente endpoint (linea que empieza con dos espacios + slash) o el siguiente top-level.
awk -v start="$LINE" '
  NR < start { next }
  NR == start { print; in_block=1; next }
  in_block && /^  \// { exit }
  in_block && /^[a-zA-Z]/ && !/^  / { exit }
  in_block { print }
' "$SPEC"
