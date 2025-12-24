package ar.com.intrale.strings.runtime

import DIManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import ext.storage.CommKeyValueStorage
import org.kodein.di.direct
import org.kodein.di.instance

/**
 * Resuelve el idioma actual desde el almacenamiento de preferencias, con fallback a español.
 */
@Composable
fun currentLang(): String = remember {
    val storage = runCatching { DIManager.di.direct.instance<CommKeyValueStorage>() }.getOrNull()
    storage?.preferredLanguage?.ifBlank { null } ?: "es"
}
