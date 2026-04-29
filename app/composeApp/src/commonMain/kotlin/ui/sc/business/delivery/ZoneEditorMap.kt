package ui.sc.business.delivery

import androidx.compose.runtime.Composable
import asdo.business.delivery.Coordinate

/**
 * Adaptador del mapa para el editor de zonas (#2447 / R-Guru).
 *
 * Permite que el editor se acople a:
 * - Una implementación stub (mientras #2420 — setup Maps — no esté en main).
 * - La implementación real con `GoogleMap` + `Circle` cuando aterrice #2420.
 *
 * El contrato es deliberadamente angosto: el editor expone callbacks que el mapa
 * dispara cuando el usuario interactúa.
 *
 * @param center centro del círculo (null = sin centro colocado).
 * @param radiusMeters radio actual del círculo.
 * @param onMapTap callback cuando el usuario tapea una coordenada vacía.
 * @param onCenterDrag callback continuo durante el drag del centro.
 */
@Composable
expect fun ZoneEditorMap(
    center: Coordinate?,
    radiusMeters: Int,
    onMapTap: (Coordinate) -> Unit,
    onCenterDrag: (Coordinate) -> Unit,
    onCenterDragStart: () -> Unit,
)
