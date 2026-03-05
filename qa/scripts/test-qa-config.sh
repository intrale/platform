#!/usr/bin/env bash
# test-qa-config.sh — Validar configuración de variables sin lanzar emuladores
# Uso: bash qa/scripts/test-qa-config.sh [QA_SHARDS] [QA_AVD_CORES] [QA_AVD_MEMORY] [QA_NO_AFFINITY]

set -euo pipefail

echo "=== Test QA Config — Validación de variables ==="
echo ""

# Simular el setup del script principal (sin realmente lanzar emuladores)
QA_SHARDS=${1:-1}
QA_AVD_CORES=${2:-2}
QA_NO_AFFINITY=${3:-0}

# Calcular memoria según modo
if [ "$QA_SHARDS" = "3" ]; then
    QA_AVD_MEMORY=${4:-2048}  # Legacy: 2048MB si 3 shards
else
    QA_AVD_MEMORY=${4:-1536}  # Default liviano: 1536MB
fi

# Configuración de múltiples AVDs
declare -A AVD_PORTS=(
  ["virtualAndroid"]="5554"
  ["virtualAndroid2"]="5556"
  ["virtualAndroid3"]="5558"
)
declare -a AVD_NAMES=()
for i in $(seq 1 "$QA_SHARDS"); do
  if [ "$i" = "1" ]; then
    AVD_NAMES+=("virtualAndroid")
  else
    AVD_NAMES+=("virtualAndroid$i")
  fi
done

echo "Configuración cargada:"
echo "  QA_SHARDS: $QA_SHARDS"
echo "  QA_AVD_CORES: $QA_AVD_CORES"
echo "  QA_AVD_MEMORY: $QA_AVD_MEMORY"
echo "  QA_NO_AFFINITY: $QA_NO_AFFINITY"
echo ""

echo "AVDs que se lanzan:"
for avd_name in "${AVD_NAMES[@]}"; do
    port=${AVD_PORTS[$avd_name]}
    echo "  - $avd_name en puerto $port"
done
echo ""

# Validaciones
echo "Validaciones:"
if [ "$QA_SHARDS" -lt 1 ] || [ "$QA_SHARDS" -gt 3 ]; then
    echo "  ✗ QA_SHARDS debe ser 1, 2 o 3 (actual: $QA_SHARDS)"
    exit 1
fi
echo "  ✓ QA_SHARDS=$QA_SHARDS es válido"

if [ "$QA_AVD_CORES" -lt 1 ] || [ "$QA_AVD_CORES" -gt 8 ]; then
    echo "  ✗ QA_AVD_CORES debe estar entre 1 y 8 (actual: $QA_AVD_CORES)"
    exit 1
fi
echo "  ✓ QA_AVD_CORES=$QA_AVD_CORES es válido"

if [ "$QA_AVD_MEMORY" -lt 512 ] || [ "$QA_AVD_MEMORY" -gt 4096 ]; then
    echo "  ✗ QA_AVD_MEMORY debe estar entre 512 y 4096 (actual: $QA_AVD_MEMORY)"
    exit 1
fi
echo "  ✓ QA_AVD_MEMORY=$QA_AVD_MEMORY es válido"

if [ "$QA_NO_AFFINITY" != "0" ] && [ "$QA_NO_AFFINITY" != "1" ]; then
    echo "  ✗ QA_NO_AFFINITY debe ser 0 o 1 (actual: $QA_NO_AFFINITY)"
    exit 1
fi
echo "  ✓ QA_NO_AFFINITY=$QA_NO_AFFINITY es válido"

# Estimación de recursos
TOTAL_RAM=$((QA_SHARDS * QA_AVD_MEMORY))
echo ""
echo "Estimación de recursos:"
echo "  RAM total (emuladores): $TOTAL_RAM MB"
echo "  Cores: ${QA_AVD_CORES} por AVD × $QA_SHARDS AVDs"
if [ "$QA_NO_AFFINITY" = "0" ]; then
    echo "  CPU Affinity: ON (emulador cores 4-7, agentes 0-3)"
else
    echo "  CPU Affinity: OFF (debug mode)"
fi

if [ "$QA_SHARDS" -eq 1 ] && [ "$QA_AVD_MEMORY" -eq 1536 ] && [ "$QA_AVD_CORES" -eq 2 ]; then
    echo ""
    echo "✅ MODO LIVIANO DETECTADO — perfecto para desarrollo con agentes"
elif [ "$QA_SHARDS" -eq 3 ] && [ "$QA_AVD_MEMORY" -eq 2048 ]; then
    echo ""
    echo "✅ MODO PARALELO LEGACY DETECTADO — para máquinas con más recursos"
fi

echo ""
echo "=== Test passou OK ==="
