#!/usr/bin/env bash
# Wrapper para compatibilidad hacia atrás.
# Mantiene la ruta histórica ./init.sh en el raíz del repo
# delegando toda la lógica a scripts/init.sh.

set -euo pipefail
exec bash "$(dirname "$0")/scripts/init.sh" "$@"
