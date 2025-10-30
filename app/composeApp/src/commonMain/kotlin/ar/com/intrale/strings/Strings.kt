package ar.com.intrale.strings

import androidx.compose.runtime.Composable
import ar.com.intrale.strings.model.MessageKey
import ar.com.intrale.strings.runtime.currentBrand
import ar.com.intrale.strings.runtime.currentLang
import ui.util.resString

/**
 * Punto único de acceso a textos.
 * Prioridad: catálogo del brand (si existe) > catálogo default > key.name
 *
 * Por ahora no usamos composeId ni androidId: todo pasa por fallback.
 * Cuando termines la migración, podremos borrar Compose Resources y strings.xml.
 */
@Composable
fun Txt(
    key: MessageKey,
    params: Map<String, String> = emptyMap()
): String {
    val lang = currentLang()
    val brand = currentBrand()
    val interpolated = resolveMessage(key, params, lang, brand)

    // Usamos el wrapper multiplataforma. No hay llamada composable adentro (va por fallback).
    return resString(
        androidId = null,
        composeId = null,
        fallbackAsciiSafe = interpolated
    )
}
