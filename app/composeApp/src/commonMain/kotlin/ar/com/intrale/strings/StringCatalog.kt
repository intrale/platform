package ar.com.intrale.strings

import kotlin.jvm.JvmInline

/** Id de marca (ej: "intrale", "clienteX"). */
@JvmInline
value class BrandId(val value: String)

/** Idioma en formato BCP-47 simple (ej: "es", "en"). */
@JvmInline
value class Lang(val value: String)

/** Catálogo inmutable para un idioma. */
typealias LangBundle = Map<StringKey, String>

/** Catálogo completo: por idioma, bundles; y overrides por marca. */
data class StringCatalog(
    val defaultsByLang: Map<Lang, LangBundle>,
    val brandOverrides: Map<BrandId, Map<Lang, LangBundle>> = emptyMap()
) {
    fun resolve(key: StringKey, brand: BrandId?, lang: Lang): String? {
        // 1) si hay override de marca+lang, gana
        brand?.let { b ->
            brandOverrides[b]?.get(lang)?.get(key)?.let { return it }
        }
        // 2) si no, default del lang
        return defaultsByLang[lang]?.get(key)
    }
}
