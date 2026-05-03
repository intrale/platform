#!/usr/bin/env bash
# Uso: scaffold-module.sh <module-name>
# Crea la estructura minima de un nuevo modulo backend Kotlin/Ktor:
# build.gradle.kts (clonado de users), carpetas src/main + src/test,
# application.conf vacio, placeholder Modules.kt con bind Kodein vacio,
# y registra el modulo en settings.gradle.kts.
# Si el modulo ya existe, falla limpio sin sobreescribir.

set -uo pipefail

MODULE="${1:-}"
if [[ -z "$MODULE" ]]; then
  echo "ERROR: falta el nombre del modulo." >&2
  echo "Uso: $0 <module-name>" >&2
  exit 2
fi

# Validar nombre: solo letras minusculas y guiones, no empezar con guion
if ! [[ "$MODULE" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: nombre invalido '$MODULE'." >&2
  echo "Solo minusculas, digitos y guiones; debe empezar con letra." >&2
  exit 2
fi

# CamelCase para clase (foo-bar -> FooBar) y camelCase para identificador (foo-bar -> fooBar)
NAME_CLASS=""
IFS='-' read -ra PARTS <<< "$MODULE"
for part in "${PARTS[@]}"; do
  NAME_CLASS+="$(echo "${part:0:1}" | tr '[:lower:]' '[:upper:]')${part:1}"
done
NAME_CAMEL="$(echo "${NAME_CLASS:0:1}" | tr '[:upper:]' '[:lower:]')${NAME_CLASS:1}"

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

MODULE_DIR="${ROOT}/${MODULE}"
SETTINGS="${ROOT}/settings.gradle.kts"
USERS_BUILD="${ROOT}/users/build.gradle.kts"

if [[ -e "$MODULE_DIR" ]]; then
  echo "ERROR: el directorio '${MODULE_DIR}' ya existe." >&2
  echo "Usa otro nombre o eliminalo manualmente si es residual." >&2
  exit 3
fi

if grep -qE "^include\(\":${MODULE}\"\)\s*$" "$SETTINGS"; then
  echo "ERROR: el modulo ':${MODULE}' ya esta declarado en settings.gradle.kts." >&2
  exit 3
fi

if [[ ! -f "$USERS_BUILD" ]]; then
  echo "ERROR: no se encontro 'users/build.gradle.kts' como template base." >&2
  exit 4
fi

echo "Creando modulo ':${MODULE}' (clase Modules: ${NAME_CLASS}Modules)..."

mkdir -p "${MODULE_DIR}/src/main/kotlin/ar/com/intrale"
mkdir -p "${MODULE_DIR}/src/main/resources"
mkdir -p "${MODULE_DIR}/src/test/kotlin/ar/com/intrale"

# build.gradle.kts: clonar de users como punto de partida.
cp "$USERS_BUILD" "${MODULE_DIR}/build.gradle.kts"

# application.conf vacio (CI/Lambda inyecta secrets en deploy).
cat > "${MODULE_DIR}/src/main/resources/application.conf" <<'EOF'
# Configuracion del modulo. CI/Lambda inyecta secrets en deploy.
# Ver users/src/main/resources/application.conf para referencia.
EOF

# Placeholder Modules.kt con bind Kodein vacio.
cat > "${MODULE_DIR}/src/main/kotlin/ar/com/intrale/${NAME_CLASS}Modules.kt" <<EOF
package ar.com.intrale

import org.kodein.di.DI

/**
 * DI module para :${MODULE}.
 * Registrar funciones (bindSingleton<Function>(tag = "...") { ... }),
 * tablas DynamoDB y servicios propios del bounded context.
 */
val ${NAME_CAMEL}Module = DI.Module("${NAME_CAMEL}Module") {
    // bindSingleton<Function>(tag = "ejemplo") { Ejemplo(instance()) }
}
EOF

# Registrar en settings.gradle.kts conservando indentacion.
# Insertamos despues del ultimo include() existente.
TMP="$(mktemp)"
awk -v line="include(\":${MODULE}\")" '
  /^include\(/ { last_include = NR; lines[NR] = $0; next }
  { lines[NR] = $0 }
  END {
    for (i = 1; i <= NR; i++) {
      print lines[i]
      if (i == last_include) print line
    }
  }
' "$SETTINGS" > "$TMP"

if ! diff -q "$SETTINGS" "$TMP" > /dev/null; then
  mv "$TMP" "$SETTINGS"
else
  rm -f "$TMP"
  echo "WARN: no se pudo insertar include automaticamente, agregalo a mano." >&2
fi

cat <<EOF

[OK] Modulo ':${MODULE}' creado.

Estructura generada:
  ${MODULE}/build.gradle.kts           (clonado de users; ajustar deps)
  ${MODULE}/src/main/kotlin/ar/com/intrale/${NAME_CLASS}Modules.kt
  ${MODULE}/src/main/resources/application.conf
  ${MODULE}/src/test/kotlin/ar/com/intrale/

settings.gradle.kts: registrado include(":${MODULE}").

Checklist (siguiente, manual):
  1. Ajustar dependencias en ${MODULE}/build.gradle.kts (quitar deps de users que no apliquen).
  2. Definir el/los bindSingleton<Function>(tag = "...") en ${NAME_CLASS}Modules.kt.
  3. Agregar las tablas DynamoDB necesarias (bind<DynamoDbTable<X>>) si aplica.
  4. Definir endpoints en docs/api/openapi.yaml (Spec-Driven).
  5. Registrar el modulo DI en el entry point (Application.kt o equivalente).
  6. Si va a Lambda, configurar shadowJar y el handler en CI/CD.
  7. Agregar tests en ${MODULE}/src/test/kotlin/ar/com/intrale/.
EOF
