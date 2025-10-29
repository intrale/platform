package ar.com.intrale.strings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf

val LocalBrand = staticCompositionLocalOf<BrandId?> { null }
val LocalLang = staticCompositionLocalOf { Lang("es") }

/** Helpers de conveniencia */
@Composable
fun tr(key: StringKey): String =
    Strings.t(key, LocalBrand.current, LocalLang.current)

@Composable
fun tr(key: StringKey, args: Map<String, String>): String =
    Strings.t(key, args, LocalBrand.current, LocalLang.current)
