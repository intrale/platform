package ui.sc.client

import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone

/**
 * Estado de la pantalla `ZonesMapScreen` (issue #2423 — Hija B).
 *
 * Contempla los 4 sub-estados del CA-5 del PO:
 * - `Loading` — skeleton + texto accesible (UX-4).
 * - `Loaded` — mapa + chips + lista + bounding box (UX-2).
 * - `Empty` — backend devolvio `zones: []` (UX-6 con copy empatico).
 * - `Error` — fallo de red / HTTP >=500 (UX-5 con dos acciones).
 */
data class ZonesMapUIState(
    val phase: ZonesMapPhase = ZonesMapPhase.Loading,
    val zones: List<SanitizedBusinessZone> = emptyList(),
    val boundingBox: SanitizedBoundingBox? = null,
    val errorMessage: String? = null,
    val showsListExpanded: Boolean = false,
)

enum class ZonesMapPhase { Loading, Loaded, Empty, Error }
