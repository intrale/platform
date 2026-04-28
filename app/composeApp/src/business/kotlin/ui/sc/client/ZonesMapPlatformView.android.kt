package ui.sc.client

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone

/**
 * Stub no-op de [ZonesMapPlatformView] para el flavor `business`
 * (Intrale Negocios) — issue #2423.
 *
 * La feature de mapa de zonas es exclusiva del App Cliente (label
 * `app:client` en el issue), por lo que aca no embebemos OSMDroid: la
 * dependencia esta scopeada como `clientImplementation` en
 * `app/composeApp/build.gradle.kts:514` y no se incluye en el APK
 * de Negocios.
 *
 * Igual necesitamos proveer un `actual` porque la `expect` esta
 * declarada en `commonMain` y AGP requiere un actual por cada
 * variante Android (client / business / delivery).
 */
@Composable
actual fun ZonesMapPlatformView(
    modifier: Modifier,
    zones: List<SanitizedBusinessZone>,
    boundingBox: SanitizedBoundingBox?,
    zoneColors: List<Long>,
) {
    Box(modifier = modifier.fillMaxSize())
}

/** En Negocios no renderizamos mapa interactivo. */
actual val isInteractiveMapAvailable: Boolean = false
