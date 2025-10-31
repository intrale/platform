package ar.com.intrale.strings

import androidx.compose.runtime.Composable
import ar.com.intrale.strings.catalog.DefaultCatalog_en
import ar.com.intrale.strings.catalog.DefaultCatalog_es
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

    // 1) Catálogo default por idioma (expandible)
    val defaultCatalog = when (lang) {
        "es" -> DefaultCatalog_es
        "en" -> DefaultCatalog_en
        else -> DefaultCatalog_en
    }

    // 2) Catálogo por brand+idioma (a futuro)
    val brandCatalog: Map<MessageKey, String> = emptyMap()

    val template = brandCatalog[key] ?: defaultCatalog[key] ?: key.name

    val interpolated = if (params.isEmpty()) {
        template
    } else {
        // Interpolación súper simple: reemplaza {param}
        params.entries.fold(template) { acc, (k, v) ->
            acc.replace("{$k}", v)
        }
    }

    // Usamos el wrapper multiplataforma. No hay llamada composable adentro (va por fallback).
    return resString(
        androidId = null,
        fallbackAsciiSafe = interpolated
    )
}
