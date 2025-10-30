package ar.com.intrale.strings

import ar.com.intrale.strings.catalog.DefaultCatalog_en
import ar.com.intrale.strings.catalog.DefaultCatalog_es
import ar.com.intrale.strings.model.MessageKey

private fun defaultCatalogFor(lang: String): Map<MessageKey, String> = when (lang) {
    "es" -> DefaultCatalog_es
    "en" -> DefaultCatalog_en
    else -> DefaultCatalog_en
}

private fun brandCatalogFor(brand: String?, lang: String): Map<MessageKey, String> {
    // Todavía no tenemos catálogos específicos por marca.
    // Dejamos el hook armado para futuras extensiones.
    return emptyMap()
}

private fun resolveTemplate(
    key: MessageKey,
    lang: String,
    brand: String?
): String {
    val brandCatalog = brandCatalogFor(brand, lang)
    val defaultCatalog = defaultCatalogFor(lang)
    return brandCatalog[key] ?: defaultCatalog[key] ?: key.name
}

private fun interpolate(
    template: String,
    params: Map<String, String>
): String {
    if (params.isEmpty()) return template
    return params.entries.fold(template) { acc, (param, value) ->
        acc.replace("{$param}", value)
    }
}

fun resolveMessage(
    key: MessageKey,
    params: Map<String, String> = emptyMap(),
    lang: String = "es",
    brand: String? = "default"
): String = interpolate(resolveTemplate(key, lang, brand), params)
