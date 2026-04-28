package ui.sc.client

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone

/**
 * Wrapper expect/actual del mapa interactivo (issue #2423 CA-7).
 *
 * - `androidMain` -> OSMDroid via `AndroidView { MapView }`.
 * - `iosMain` / `desktopMain` / `wasmJsMain` -> renderiza un placeholder
 *   accesible. La lista textual la dibuja el screen comun, asi que aca
 *   solo necesitamos un slot vacio sin romper layout.
 *
 * Recibe siempre `zones` ya saneadas y `boundingBox` ya calculado — no
 * hace I/O ni accede a coordenadas del usuario (Security A09).
 *
 * @param zoneColors lista paralela a `zones` con los colores ARGB
 *   asignados (paleta daltonic-safe, ver `ZoneColorPalette`).
 */
@Composable
expect fun ZonesMapPlatformView(
    modifier: Modifier,
    zones: List<SanitizedBusinessZone>,
    boundingBox: SanitizedBoundingBox?,
    zoneColors: List<Long>,
)

/** Indica si la plataforma actual renderiza un mapa interactivo real. */
expect val isInteractiveMapAvailable: Boolean
