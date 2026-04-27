package asdo.client

/**
 * Coordenadas geográficas para verificar zona de cobertura.
 *
 * Privacidad / Konform (CA-5, CA-6):
 * - `latitude` debe estar en [-90.0, 90.0].
 * - `longitude` debe estar en [-180.0, 180.0].
 * - `NaN`, `Infinity`, `-Infinity` no se aceptan.
 *
 * Estas coordenadas viven SOLO en memoria del ViewModel; nunca se persisten
 * en SharedPreferences/DataStore/archivos. No agregar `@Serializable` ni
 * helpers de cache para evitar regresiones accidentales.
 */
data class ZoneCheckCoordinates(
    val latitude: Double,
    val longitude: Double
) {
    /**
     * Chequeo rápido sin Konform: la UI lo usa para habilitar el botón
     * "Verificar" sólo cuando hay un par de coordenadas razonable. La
     * validación autoritativa vive en `DoCheckAddress.coordinatesValidation`.
     *
     * No se valida en `init` con `require` para que `DoCheckAddress` pueda
     * recibir entradas inválidas (NaN/Infinity/fuera de rango) y devolver
     * un [ZoneCheckException.Invalid] tipado, evitando que la app crashee.
     */
    fun isWellFormed(): Boolean =
        !latitude.isNaN() && !latitude.isInfinite() &&
            !longitude.isNaN() && !longitude.isInfinite() &&
            latitude in -90.0..90.0 && longitude in -180.0..180.0
}

/**
 * Resultado de la verificación de zona ya validado y listo para mostrar en UI.
 *
 * Validación (CA-6):
 * - `shippingCost` está acotado al rango [0, 100_000]. Fuera de ese rango,
 *   `DoCheckAddress` retorna failure con [ZoneCheckException.OutOfRange].
 * - `etaMinutes` puede venir nulo si el backend no lo informa.
 */
data class ZoneCheckResult(
    val inZone: Boolean,
    val shippingCost: Double = 0.0,
    val etaMinutes: Int? = null,
    val zoneId: String? = null,
)

/**
 * Excepciones tipadas para `DoCheckAddress`. El motivo permite que la UI
 * decida si mostrar reintento (Network/Server) vs error genérico (OutOfRange,
 * Invalid).
 */
sealed class ZoneCheckException(
    override val message: String
) : Throwable(message) {
    object Invalid : ZoneCheckException("Las coordenadas ingresadas no son válidas")
    object OutOfRange : ZoneCheckException("La respuesta del servicio está fuera de rango")
    data class Network(val cause0: Throwable? = null) :
        ZoneCheckException("No pudimos verificar la zona, probá de nuevo")
    data class Server(val statusCode: Int, val detail: String) :
        ZoneCheckException("Error del servidor verificando zona ($statusCode)")
    object Unknown : ZoneCheckException("Error inesperado verificando zona")
}
