package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para traducir el catalogo de un negocio.
 */
data class TranslateCatalogRequest(
    val targetLocale: String = "",
    val productIds: List<String>? = null,
    val offset: Int = 0,
    val limit: Int = 20
)

/**
 * Producto traducido con indicador de traduccion automatica.
 */
data class TranslatedProductPayload(
    val id: String,
    val name: String,
    val originalName: String,
    val shortDescription: String? = null,
    val originalDescription: String? = null,
    val basePrice: Double,
    val unit: String,
    val categoryId: String,
    val isAvailable: Boolean,
    val isFeatured: Boolean = false,
    val promotionPrice: Double? = null,
    val stockQuantity: Int? = null,
    val translated: Boolean = false,
    val targetLocale: String = "",
    val sourceLocale: String = "es"
)

/**
 * Respuesta del endpoint de traduccion de catalogo.
 */
class TranslateCatalogResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val products: List<TranslatedProductPayload> = emptyList(),
    val pagination: PaginationMetadata? = null,
    val translated: Boolean = false,
    val targetLocale: String = "",
    val sourceLocale: String = "es",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint publico que traduce el catalogo de productos de un negocio
 * al idioma especificado por el cliente.
 *
 * Ruta: POST /{business}/translate-catalog
 *
 * Detecta el locale del cliente, traduce nombres y descripciones on-demand,
 * cachea las traducciones para no repetir llamadas a la API.
 * Precios, unidades y nombres propios no se traducen.
 */
class TranslateCatalogFunction(
    private val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>,
    private val productRepository: ProductRepository,
    private val translationService: TranslationService,
    private val translationCache: TranslationCacheRepository
) : Function {

    companion object {
        const val MAX_LIMIT = 50
        const val DEFAULT_LIMIT = 20
    }

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando traduccion de catalogo para negocio=$business")

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        // Determinar el locale destino: del body, del header Accept-Language, o del query param
        val request = parseBody<TranslateCatalogRequest>(textBody)
        val targetLocale = resolveTargetLocale(request, headers)

        if (targetLocale == null) {
            return RequestValidationException("Se requiere targetLocale en el body o header Accept-Language")
        }

        if (targetLocale !in ClaudeTranslationService.SUPPORTED_LOCALES) {
            return RequestValidationException(
                "Locale '$targetLocale' no soportado. Soportados: ${ClaudeTranslationService.SUPPORTED_LOCALES.joinToString(", ")}"
            )
        }

        // Si el locale es el mismo que el del catalogo (espanol), devolver sin traducir
        val sourceLocale = "es"
        if (targetLocale == sourceLocale) {
            return buildUntranslatedResponse(business, request, sourceLocale)
        }

        // Obtener productos publicados
        val offset = request?.offset?.coerceAtLeast(0) ?: 0
        val limit = request?.limit?.coerceIn(1, MAX_LIMIT) ?: DEFAULT_LIMIT
        val productIds = request?.productIds

        val products = if (productIds != null && productIds.isNotEmpty()) {
            // Filtrar por IDs especificos
            productIds.mapNotNull { productRepository.getProduct(business, it) }
                .filter { it.status.uppercase() == "PUBLISHED" }
        } else {
            // Listar con paginacion
            val paginated = productRepository.listPublishedProductsPaginated(
                business = business,
                offset = offset,
                limit = limit
            )
            paginated.items
        }

        if (products.isEmpty()) {
            return TranslateCatalogResponse(
                products = emptyList(),
                pagination = PaginationMetadata(0, offset, limit, false),
                translated = false,
                targetLocale = targetLocale,
                sourceLocale = sourceLocale
            )
        }

        // Separar productos cacheados de los que necesitan traduccion
        val cachedProducts = mutableListOf<TranslatedProductPayload>()
        val productsToTranslate = mutableListOf<ProductRecord>()

        for (product in products) {
            val (cachedName, cachedDesc) = translationCache.getProductTranslation(
                business, product.id, targetLocale
            )
            if (cachedName != null) {
                cachedProducts.add(
                    product.toTranslatedPayload(
                        translatedName = cachedName,
                        translatedDescription = cachedDesc,
                        targetLocale = targetLocale,
                        sourceLocale = sourceLocale
                    )
                )
            } else {
                productsToTranslate.add(product)
            }
        }

        logger.debug("Catalogo negocio=$business: ${cachedProducts.size} en cache, ${productsToTranslate.size} por traducir")

        // Traducir los que faltan en batch
        val translatedProducts = if (productsToTranslate.isNotEmpty()) {
            translateProducts(business, productsToTranslate, targetLocale, sourceLocale)
        } else {
            emptyList()
        }

        // Combinar resultados manteniendo el orden original
        val allTranslated = mutableListOf<TranslatedProductPayload>()
        val cachedMap = cachedProducts.associateBy { it.id }
        val translatedMap = translatedProducts.associateBy { it.id }

        for (product in products) {
            val translated = cachedMap[product.id]
                ?: translatedMap[product.id]
                ?: product.toTranslatedPayload(
                    translatedName = product.name,
                    translatedDescription = product.shortDescription,
                    targetLocale = targetLocale,
                    sourceLocale = sourceLocale,
                    wasTranslated = false
                )
            allTranslated.add(translated)
        }

        val total = if (productIds != null) products.size else {
            productRepository.listPublishedProducts(business).size
        }

        return TranslateCatalogResponse(
            products = allTranslated,
            pagination = PaginationMetadata(
                total = total,
                offset = offset,
                limit = limit,
                hasMore = offset + limit < total
            ),
            translated = true,
            targetLocale = targetLocale,
            sourceLocale = sourceLocale
        )
    }

    /**
     * Traduce una lista de productos en batch usando el servicio de traduccion.
     * Cachea los resultados para futuras consultas.
     */
    private suspend fun translateProducts(
        business: String,
        products: List<ProductRecord>,
        targetLocale: String,
        sourceLocale: String
    ): List<TranslatedProductPayload> {
        // Construir lista de textos para traducir: nombres + descripciones intercalados
        val textsToTranslate = mutableListOf<String>()
        val textMapping = mutableListOf<Pair<Int, String>>() // (productIndex, field)

        for ((index, product) in products.withIndex()) {
            textsToTranslate.add(product.name)
            textMapping.add(Pair(index, "name"))

            textsToTranslate.add(product.shortDescription ?: "")
            textMapping.add(Pair(index, "description"))
        }

        val translationResult = translationService.translateBatch(
            texts = textsToTranslate,
            targetLocale = targetLocale,
            sourceLocale = sourceLocale
        )

        if (translationResult.isFailure) {
            logger.error("Error traduciendo productos: ${translationResult.exceptionOrNull()?.message}")
            // Devolver productos sin traducir como fallback
            return products.map { it.toTranslatedPayload(
                translatedName = it.name,
                translatedDescription = it.shortDescription,
                targetLocale = targetLocale,
                sourceLocale = sourceLocale,
                wasTranslated = false
            ) }
        }

        val translations = translationResult.getOrThrow()
        val translatedProducts = mutableListOf<TranslatedProductPayload>()

        // Reconstruir productos con traducciones
        for ((index, product) in products.withIndex()) {
            val nameIdx = index * 2
            val descIdx = index * 2 + 1

            val translatedName = translations.getOrElse(nameIdx) { product.name }
            val translatedDesc = if (product.shortDescription != null) {
                translations.getOrElse(descIdx) { product.shortDescription }.ifBlank { null }
            } else null

            // Cachear la traduccion
            translationCache.putProductTranslation(
                business = business,
                productId = product.id,
                locale = targetLocale,
                originalName = product.name,
                translatedName = translatedName,
                originalDescription = product.shortDescription,
                translatedDescription = translatedDesc,
                sourceLocale = sourceLocale
            )

            translatedProducts.add(
                product.toTranslatedPayload(
                    translatedName = translatedName,
                    translatedDescription = translatedDesc,
                    targetLocale = targetLocale,
                    sourceLocale = sourceLocale
                )
            )
        }

        return translatedProducts
    }

    /**
     * Resuelve el locale destino desde el request body, query param o header Accept-Language.
     */
    internal fun resolveTargetLocale(
        request: TranslateCatalogRequest?,
        headers: Map<String, String>
    ): String? {
        // Prioridad 1: body del request
        if (!request?.targetLocale.isNullOrBlank()) {
            return normalizeLocale(request!!.targetLocale)
        }

        // Prioridad 2: query parameter
        val queryLocale = headers["X-Query-locale"]
        if (!queryLocale.isNullOrBlank()) {
            return normalizeLocale(queryLocale)
        }

        // Prioridad 3: header Accept-Language
        val acceptLanguage = headers["Accept-Language"]
        if (!acceptLanguage.isNullOrBlank()) {
            return parseAcceptLanguage(acceptLanguage)
        }

        return null
    }

    /**
     * Normaliza un locale a su codigo de 2 letras (ej: "en-US" -> "en", "pt-BR" -> "pt").
     */
    internal fun normalizeLocale(locale: String): String {
        return locale.trim().lowercase().take(2)
    }

    /**
     * Parsea el header Accept-Language y devuelve el locale preferido.
     * Formato: "en-US,en;q=0.9,es;q=0.8"
     */
    internal fun parseAcceptLanguage(header: String): String? {
        return header.split(",")
            .map { part ->
                val segments = part.trim().split(";")
                val locale = segments[0].trim()
                val quality = segments.getOrNull(1)
                    ?.trim()
                    ?.removePrefix("q=")
                    ?.toDoubleOrNull()
                    ?: 1.0
                Pair(locale, quality)
            }
            .sortedByDescending { it.second }
            .firstOrNull()
            ?.first
            ?.let { normalizeLocale(it) }
    }

    /**
     * Construye respuesta sin traduccion (cuando el locale es el mismo que el origen).
     */
    private fun buildUntranslatedResponse(
        business: String,
        request: TranslateCatalogRequest?,
        sourceLocale: String
    ): TranslateCatalogResponse {
        val offset = request?.offset?.coerceAtLeast(0) ?: 0
        val limit = request?.limit?.coerceIn(1, MAX_LIMIT) ?: DEFAULT_LIMIT

        val paginated = productRepository.listPublishedProductsPaginated(
            business = business,
            offset = offset,
            limit = limit
        )

        val products = paginated.items.map {
            it.toTranslatedPayload(
                translatedName = it.name,
                translatedDescription = it.shortDescription,
                targetLocale = sourceLocale,
                sourceLocale = sourceLocale,
                wasTranslated = false
            )
        }

        return TranslateCatalogResponse(
            products = products,
            pagination = PaginationMetadata(
                total = paginated.total,
                offset = paginated.offset,
                limit = paginated.limit,
                hasMore = paginated.hasMore
            ),
            translated = false,
            targetLocale = sourceLocale,
            sourceLocale = sourceLocale
        )
    }
}

/**
 * Extension para convertir ProductRecord a TranslatedProductPayload.
 */
fun ProductRecord.toTranslatedPayload(
    translatedName: String,
    translatedDescription: String?,
    targetLocale: String,
    sourceLocale: String,
    wasTranslated: Boolean = true
) = TranslatedProductPayload(
    id = id,
    name = translatedName,
    originalName = name,
    shortDescription = translatedDescription,
    originalDescription = shortDescription,
    basePrice = basePrice,
    unit = unit,
    categoryId = categoryId,
    isAvailable = isAvailable,
    isFeatured = isFeatured,
    promotionPrice = promotionPrice,
    stockQuantity = stockQuantity,
    translated = wasTranslated,
    targetLocale = targetLocale,
    sourceLocale = sourceLocale
)
