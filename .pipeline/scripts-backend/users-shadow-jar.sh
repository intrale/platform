#!/usr/bin/env bash
# Uso: users-shadow-jar.sh
# Genera el JAR para AWS Lambda del modulo :users.
# El artefacto sale en users/build/libs/users-all.jar y CI lo deploya a la Lambda kotlinTest.

set -uo pipefail

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"

cd "$(dirname "$0")/../.."

OUT="$(./gradlew :users:shadowJar --no-daemon 2>&1)"
RC=$?

echo "$OUT" | tail -30
echo
echo "----"
JAR="users/build/libs/users-all.jar"
if [[ -f "$JAR" ]]; then
  SIZE=$(du -h "$JAR" | awk '{print $1}')
  echo "Resultado: ${JAR} (${SIZE})"
else
  echo "Resultado: shadow jar NO encontrado en ${JAR}"
fi
echo "Exit: $RC"
exit $RC
