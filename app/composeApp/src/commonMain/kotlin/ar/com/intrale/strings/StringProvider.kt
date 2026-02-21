@file:Suppress("DEPRECATION_ERROR")

package ar.com.intrale.strings

/**
 * Proveedor legacy — reemplazado por [Txt] (composable) y [resolveMessage] (no-UI).
 */
object Strings {
    // Config por defecto mínima (es/en) para arrancar
    private var catalog: StringCatalog = StringCatalog(
        defaultsByLang = mapOf(
            Lang("es") to mapOf(
                StringKey.App_Name to "Intrale",
                StringKey.Login_Title to "Iniciar sesión",
                StringKey.Login_Button to "Entrar",
                StringKey.Error_Generic to "Ocurrió un error"
            ),
            Lang("en") to mapOf(
                StringKey.App_Name to "Intrale",
                StringKey.Login_Title to "Sign in",
                StringKey.Login_Button to "Enter",
                StringKey.Error_Generic to "Something went wrong"
            )
        )
    )
    private var currentBrand: BrandId? = null
    private var currentLang: Lang = Lang("es")

    /** setters pensados para app startup / tests */
    fun setCatalog(newCatalog: StringCatalog) { catalog = newCatalog }
    fun setBrand(brandId: BrandId?) { currentBrand = brandId }
    fun setLang(lang: Lang) { currentLang = lang }

    /** API de acceso simple */
    @Deprecated(
        message = "Usar Txt(MessageKey, params) o resolveMessage()",
        replaceWith = ReplaceWith("Txt(key, params)", "ar.com.intrale.strings.Txt"),
        level = DeprecationLevel.ERROR,
    )
    fun t(key: StringKey, brand: BrandId? = currentBrand, lang: Lang = currentLang): String {
        return catalog.resolve(key, brand, lang) ?: "⟪$key⟫"
    }

    /** Con reemplazos: "{{name}}" -> args["name"] */
    @Deprecated(
        message = "Usar Txt(MessageKey, params) o resolveMessage()",
        replaceWith = ReplaceWith("Txt(key, params)", "ar.com.intrale.strings.Txt"),
        level = DeprecationLevel.ERROR,
    )
    fun t(
        key: StringKey,
        args: Map<String, String>,
        brand: BrandId? = currentBrand,
        lang: Lang = currentLang
    ): String {
        @Suppress("DEPRECATION_ERROR")
        val base = t(key, brand, lang)
        if (args.isEmpty()) return base
        var out = base
        args.forEach { (k, v) -> out = out.replace("{{$k}}", v) }
        return out
    }
}
