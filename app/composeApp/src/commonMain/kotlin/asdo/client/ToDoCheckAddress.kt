package asdo.client

/**
 * Caso de uso para verificar si un par de coordenadas está dentro de la zona
 * de cobertura de delivery del negocio actual.
 *
 * Contrato (CA-6 / CA-9):
 * - Retorna [Result.success] con [ZoneCheckResult] válido y normalizado.
 * - Retorna [Result.failure] con un [ZoneCheckException] tipado:
 *   - [ZoneCheckException.Invalid] si las coordenadas no pasan la validación
 *     local (rango inválido / NaN / Infinity).
 *   - [ZoneCheckException.OutOfRange] si la respuesta del backend trae un
 *     `shippingCost` fuera de [0, 100_000].
 *   - [ZoneCheckException.Network] si hubo error de red / timeout. La UI debe
 *     habilitar el botón "Reintentar".
 *   - [ZoneCheckException.Server] si el backend respondió con error.
 *
 * Privacidad (CA-5 / CA-7):
 * - Las coordenadas NUNCA se loggean. Las implementaciones deben loggear
 *   exclusivamente metadata del tipo `hasCoords=true inZone=$inZone`.
 */
interface ToDoCheckAddress {
    suspend fun execute(coordinates: ZoneCheckCoordinates): Result<ZoneCheckResult>
}
