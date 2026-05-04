#!/usr/bin/env bash
# Uso: source .pipeline/scripts-backend/backend-env.sh
# Setup de JAVA_HOME y PATH para el agente /backend-dev.
# Reemplaza el bloque de exports del Paso 1 del SKILL.

export JAVA_HOME="${JAVA_HOME:-/c/Users/Administrator/.jdks/temurin-21.0.7}"
export PATH="/c/Workspaces/gh-cli/bin:${PATH}"
