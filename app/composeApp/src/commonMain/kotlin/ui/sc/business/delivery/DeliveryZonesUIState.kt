package ui.sc.business.delivery

import asdo.business.delivery.Coordinate
import asdo.business.delivery.DeliveryZone
import asdo.business.delivery.MAX_DELIVERY_ZONES_PER_BUSINESS
import asdo.business.delivery.MAX_ZONE_RADIUS_METERS
import asdo.business.delivery.MIN_ZONE_RADIUS_METERS

/**
 * Estado de la pantalla "Zonas de entrega" (lista) más sub-estado del editor (#2447).
 *
 * El editor se modela como `editor: ZoneEditorUIState?` nullable:
 * - `null` => editor cerrado.
 * - instanciado => editor abierto.
 * Esto simplifica el cleanup de logout y la recomposición.
 */
data class DeliveryZonesUIState(
    val zones: List<DeliveryZone> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val snackbarMessage: String? = null,
    val editor: ZoneEditorUIState? = null,
) {
    val zoneCount: Int get() = zones.size
    val isAtLimit: Boolean get() = zoneCount >= MAX_DELIVERY_ZONES_PER_BUSINESS
    val canCreateMore: Boolean get() = !isAtLimit
}

/** Modo del editor — la historia 2421b agregará POLYGON. */
enum class ZoneEditorMode { CIRCULAR }

/**
 * Sub-estado del editor circular (#2447). Contiene todo lo necesario para
 * recomposición + persistencia ante rotación.
 */
data class ZoneEditorUIState(
    val mode: ZoneEditorMode = ZoneEditorMode.CIRCULAR,
    val center: Coordinate? = null,
    val radiusMeters: Int = DEFAULT_RADIUS_METERS,
    val isDragging: Boolean = false,
    val sheetVisible: Boolean = false,
    val nameInput: String = "",
    val nameError: String? = null,
    val costCentsInput: String = "",
    val costError: String? = null,
    val estimatedMinutes: Int? = null,
    val timeError: String? = null,
    val isSaving: Boolean = false,
    val saveError: String? = null,
) {
    val hasCenter: Boolean get() = center != null

    val radiusBelowMinimum: Boolean
        get() = hasCenter && radiusMeters < MIN_ZONE_RADIUS_METERS

    val isRadiusValid: Boolean
        get() = hasCenter && radiusMeters in MIN_ZONE_RADIUS_METERS..MAX_ZONE_RADIUS_METERS

    val canOpenSheet: Boolean
        get() = isRadiusValid && !isSaving

    val canSave: Boolean
        get() = isRadiusValid &&
                !isSaving &&
                nameError == null &&
                nameInput.isNotBlank() &&
                costError == null &&
                estimatedMinutes != null

    companion object {
        const val DEFAULT_RADIUS_METERS: Int = 1_000
    }
}
