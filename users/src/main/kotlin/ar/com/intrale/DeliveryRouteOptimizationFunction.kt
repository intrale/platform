package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Endpoint para optimización de ruta de entregas.
 *
 * POST delivery/route-optimization
 *   Body: RouteOptimizationRequest con las paradas y posición actual del repartidor
 *   Respuesta: ruta optimizada con orden sugerido, distancias y link a Google Maps
 *
 * GET delivery/route-optimization/active
 *   Obtiene automáticamente los pedidos activos del repartidor y optimiza la ruta
 */
class DeliveryRouteOptimizationFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val orderRepository: DeliveryOrderRepository,
    private val routeService: RouteOptimizationService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val functionPath = headers["X-Function-Path"] ?: function
        val segments = functionPath.split("/").filter { it.isNotBlank() }
        // segments: ["delivery", "route-optimization", ...subPath]
        val subPath = segments.getOrNull(2)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business, email, subPath)
            HttpMethod.Post.value.uppercase() -> handlePost(business, email, textBody)
            else -> RequestValidationException("Metodo no soportado para optimizacion de ruta: $method")
        }
    }

    /**
     * GET delivery/route-optimization/active
     * Obtiene pedidos activos del repartidor y optimiza la ruta automáticamente.
     */
    private fun handleGet(business: String, email: String, subPath: String?): Response {
        return when (subPath) {
            "active" -> {
                logger.info("Optimizando ruta con pedidos activos del repartidor $email en negocio $business")
                val activeOrders = orderRepository.listActive(business, email)

                if (activeOrders.size < 2) {
                    return RouteOptimizationResponse(
                        stops = activeOrders.mapIndexed { index, order ->
                            OptimizedStopResponse(
                                position = index + 1,
                                orderId = order.id,
                                address = order.address ?: "",
                                customerName = order.customerName,
                                promisedAt = order.promisedAt,
                                distanceFromPrevious = 0.0
                            )
                        },
                        totalDistanceKm = 0.0,
                        estimatedSavingsPercent = 0.0,
                        googleMapsUrl = null,
                        message = if (activeOrders.isEmpty()) "No hay pedidos activos para optimizar"
                                  else "Solo hay un pedido activo, no se requiere optimizacion"
                    )
                }

                // Filtrar pedidos con coordenadas válidas para optimizar
                val stopsWithCoords = activeOrders.mapNotNull { order ->
                    val lat = parseCoordinate(order.address, isLatitude = true)
                    val lng = parseCoordinate(order.address, isLatitude = false)
                    if (lat != null && lng != null) {
                        RouteOptimizationService.Stop(
                            orderId = order.id,
                            address = order.address ?: "",
                            latitude = lat,
                            longitude = lng,
                            customerName = order.customerName,
                            promisedAt = order.promisedAt
                        )
                    } else null
                }

                if (stopsWithCoords.size < 2) {
                    // Sin coordenadas, devolver en orden original
                    return RouteOptimizationResponse(
                        stops = activeOrders.mapIndexed { index, order ->
                            OptimizedStopResponse(
                                position = index + 1,
                                orderId = order.id,
                                address = order.address ?: "",
                                customerName = order.customerName,
                                promisedAt = order.promisedAt,
                                distanceFromPrevious = 0.0
                            )
                        },
                        totalDistanceKm = 0.0,
                        estimatedSavingsPercent = 0.0,
                        googleMapsUrl = null,
                        message = "Pedidos sin coordenadas suficientes para optimizar la ruta"
                    )
                }

                val result = routeService.optimize(stopsWithCoords, null, null)
                toResponse(result)
            }

            else -> RequestValidationException("Sub-ruta no soportada: $subPath. Use 'active' o POST con paradas explícitas")
        }
    }

    /**
     * POST delivery/route-optimization
     * Recibe lista explícita de paradas con coordenadas y optimiza la ruta.
     */
    private fun handlePost(business: String, email: String, textBody: String): Response {
        logger.info("Optimizando ruta con paradas explícitas para repartidor $email en negocio $business")

        val request = runCatching {
            Gson().fromJson(textBody, RouteOptimizationRequest::class.java)
        }.getOrNull() ?: return RequestValidationException("Payload invalido para optimizacion de ruta")

        if (request.stops.size < 2) {
            return RequestValidationException("Se necesitan al menos 2 paradas para optimizar la ruta")
        }

        val stopsWithCoords = request.stops.filter { it.latitude != null && it.longitude != null }
        if (stopsWithCoords.size < 2) {
            return RequestValidationException("Se necesitan al menos 2 paradas con coordenadas validas")
        }

        val serviceStops = stopsWithCoords.map { stop ->
            RouteOptimizationService.Stop(
                orderId = stop.orderId,
                address = stop.address,
                latitude = stop.latitude!!,
                longitude = stop.longitude!!,
                customerName = stop.customerName,
                promisedAt = stop.promisedAt
            )
        }

        val result = routeService.optimize(
            stops = serviceStops,
            currentLat = request.currentLatitude,
            currentLng = request.currentLongitude
        )

        return toResponse(result)
    }

    private fun toResponse(result: RouteOptimizationService.OptimizationResult): RouteOptimizationResponse {
        return RouteOptimizationResponse(
            stops = result.orderedStops.mapIndexed { index, stopWithDist ->
                OptimizedStopResponse(
                    position = index + 1,
                    orderId = stopWithDist.stop.orderId,
                    address = stopWithDist.stop.address,
                    latitude = stopWithDist.stop.latitude,
                    longitude = stopWithDist.stop.longitude,
                    customerName = stopWithDist.stop.customerName,
                    promisedAt = stopWithDist.stop.promisedAt,
                    distanceFromPrevious = stopWithDist.distanceFromPreviousKm
                )
            },
            totalDistanceKm = result.totalDistanceKm,
            estimatedSavingsPercent = result.estimatedSavingsPercent,
            googleMapsUrl = result.googleMapsUrl
        )
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }

    /**
     * Intenta parsear coordenadas desde el campo address si contiene formato "lat,lng".
     * Esto es un placeholder hasta tener geocoding real.
     */
    private fun parseCoordinate(address: String?, isLatitude: Boolean): Double? {
        if (address == null) return null
        // Buscar patrón de coordenadas al final del address: "...[-]dd.dddd,[-]dd.dddd"
        val regex = Regex("""(-?\d+\.\d+),\s*(-?\d+\.\d+)""")
        val match = regex.find(address) ?: return null
        return if (isLatitude) match.groupValues[1].toDoubleOrNull()
        else match.groupValues[2].toDoubleOrNull()
    }
}
