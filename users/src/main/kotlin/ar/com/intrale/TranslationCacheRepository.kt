package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.util.concurrent.ConcurrentHashMap

/**
 * Entrada de cache para una traduccion.
 */
data class TranslationCacheEntry(
    val originalText: String,
    val translatedText: String,
    val sourceLocale: String,
    val targetLocale: String,
    val createdAt: Long = System.currentTimeMillis()
)

/**
 * Cache en memoria para traducciones de productos.
 * Key: businessId#productId#field#targetLocale
 *
 * Diseñado para ser reemplazado por DynamoDB en el futuro
 * si se necesita persistencia entre deploys.
 */
class TranslationCacheRepository {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val cache = ConcurrentHashMap<String, TranslationCacheEntry>()

    companion object {
        /** Tiempo de vida del cache: 24 horas */
        private const val TTL_MS = 24 * 60 * 60 * 1000L
    }

    private fun key(business: String, productId: String, field: String, locale: String): String =
        "${business.lowercase()}#$productId#$field#${locale.lowercase()}"

    /**
     * Obtiene una traduccion del cache si existe y no expiro.
     */
    fun get(business: String, productId: String, field: String, locale: String): String? {
        val entry = cache[key(business, productId, field, locale)] ?: return null
        if (System.currentTimeMillis() - entry.createdAt > TTL_MS) {
            cache.remove(key(business, productId, field, locale))
            return null
        }
        return entry.translatedText
    }

    /**
     * Almacena una traduccion en el cache.
     */
    fun put(
        business: String,
        productId: String,
        field: String,
        locale: String,
        originalText: String,
        translatedText: String,
        sourceLocale: String = "es"
    ) {
        cache[key(business, productId, field, locale)] = TranslationCacheEntry(
            originalText = originalText,
            translatedText = translatedText,
            sourceLocale = sourceLocale,
            targetLocale = locale,
            createdAt = System.currentTimeMillis()
        )
    }

    /**
     * Verifica si hay traducciones cacheadas para un producto y locale.
     */
    fun hasTranslation(business: String, productId: String, locale: String): Boolean {
        val nameKey = key(business, productId, "name", locale)
        return cache.containsKey(nameKey) && !isExpired(nameKey)
    }

    /**
     * Obtiene las traducciones cacheadas de nombre y descripcion de un producto.
     */
    fun getProductTranslation(
        business: String,
        productId: String,
        locale: String
    ): Pair<String?, String?> {
        val name = get(business, productId, "name", locale)
        val description = get(business, productId, "description", locale)
        return Pair(name, description)
    }

    /**
     * Almacena traducciones de nombre y descripcion de un producto.
     */
    fun putProductTranslation(
        business: String,
        productId: String,
        locale: String,
        originalName: String,
        translatedName: String,
        originalDescription: String?,
        translatedDescription: String?,
        sourceLocale: String = "es"
    ) {
        put(business, productId, "name", locale, originalName, translatedName, sourceLocale)
        if (originalDescription != null && translatedDescription != null) {
            put(business, productId, "description", locale, originalDescription, translatedDescription, sourceLocale)
        }
    }

    /**
     * Limpia entradas expiradas del cache.
     */
    fun evictExpired() {
        val now = System.currentTimeMillis()
        cache.entries.removeIf { now - it.value.createdAt > TTL_MS }
    }

    /**
     * Cantidad de entradas en el cache.
     */
    fun size(): Int = cache.size

    private fun isExpired(cacheKey: String): Boolean {
        val entry = cache[cacheKey] ?: return true
        return System.currentTimeMillis() - entry.createdAt > TTL_MS
    }
}
