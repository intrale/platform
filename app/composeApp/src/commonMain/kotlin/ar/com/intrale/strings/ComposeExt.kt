@file:Suppress("DEPRECATION_ERROR")

package ar.com.intrale.strings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf

val LocalBrand = staticCompositionLocalOf<BrandId?> { null }
val LocalLang = staticCompositionLocalOf { Lang("es") }

/** Helpers legacy — usar [Txt] en su lugar. */
@Deprecated(
    message = "Usar Txt(MessageKey, params)",
    replaceWith = ReplaceWith("Txt(key, params)", "ar.com.intrale.strings.Txt"),
    level = DeprecationLevel.ERROR,
)
@Composable
fun tr(key: StringKey): String =
    Strings.t(key, LocalBrand.current, LocalLang.current)

@Deprecated(
    message = "Usar Txt(MessageKey, params)",
    replaceWith = ReplaceWith("Txt(key, params)", "ar.com.intrale.strings.Txt"),
    level = DeprecationLevel.ERROR,
)
@Composable
fun tr(key: StringKey, args: Map<String, String>): String =
    Strings.t(key, args, LocalBrand.current, LocalLang.current)
