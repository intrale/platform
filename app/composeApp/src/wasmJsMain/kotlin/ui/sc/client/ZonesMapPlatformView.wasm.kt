package ui.sc.client

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone

/**
 * Web/Wasm fallback de [ZonesMapPlatformView] (issue #2423 CA-7).
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

actual val isInteractiveMapAvailable: Boolean = false
