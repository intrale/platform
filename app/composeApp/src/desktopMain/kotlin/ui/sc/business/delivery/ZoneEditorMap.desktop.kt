package ui.sc.business.delivery

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import asdo.business.delivery.Coordinate

/**
 * No-op desktop. El editor de zonas (#2447) sólo se monta en Android (flavor business).
 */
@Composable
actual fun ZoneEditorMap(
    center: Coordinate?,
    radiusMeters: Int,
    onMapTap: (Coordinate) -> Unit,
    onCenterDrag: (Coordinate) -> Unit,
    onCenterDragStart: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize())
}
