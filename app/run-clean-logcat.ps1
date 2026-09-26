# Copyright (c) 2026 Leonel Larreta
# SPDX-License-Identifier: LicenseRef-Proprietary

# Ruta del archivo de exclusión
$excludeFile = ".\logcat-exclude.txt"
$logDir = ".\logs"
$logFile = "$logDir\logcat_cleaned.txt"

# Obtener la fecha actual en formato MM-dd (igual al de adb logcat)
$today = Get-Date -Format "MM-dd"

# Validar archivo de exclusión
if (!(Test-Path $excludeFile)) {
    Write-Error "El archivo 'logcat-exclude.txt' no existe."
    exit 1
}

# Crear directorio de logs si no existe
if (!(Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

# Cargar y preparar regex de exclusión
$patterns = Get-Content $excludeFile | Where-Object { $_ -ne "" } | ForEach-Object { [Regex]::Escape($_) }
$excludeRegex = ($patterns -join "|")

# Limpiar archivo anterior
Clear-Content $logFile -ErrorAction SilentlyContinue

# Leer logcat, aplicar doble filtro: por fecha actual y por exclusión de ruido
adb logcat | ForEach-Object {
    if ($_ -match $today -and $_ -notmatch $excludeRegex) {
        $_
        $_ | Out-File -Append -FilePath $logFile -Encoding utf8
    }
}
