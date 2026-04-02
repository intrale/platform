package asdo.client

/**
 * Resultado de la verificación de si un negocio está abierto en este momento.
 *
 * @property isOpen true si el negocio está atendiendo ahora
 * @property temporarilyClosed true si el negocio está cerrado temporalmente (vacaciones, etc.)
 * @property nextOpeningInfo texto descriptivo del próximo horario de apertura (ej: "Abre mañana a las 09:00")
 * @property reopenDate fecha de reapertura si está cerrado temporalmente
 */
data class BusinessOpenStatus(
    val isOpen: Boolean,
    val temporarilyClosed: Boolean = false,
    val nextOpeningInfo: String = "",
    val reopenDate: String = ""
)
