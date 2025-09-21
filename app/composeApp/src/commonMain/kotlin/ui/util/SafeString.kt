@file:Suppress("FunctionName")

package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

private val safeStringLogger: Logger = LoggerFactory.default.newLogger("ui.util", "SafeString")

@OptIn(ExperimentalResourceApi::class)
@Composable
fun safeString(id: StringResource, fallback: String = "—"): String =
    safeResource(
        load = { stringResource(id) },
        fallback = fallback,
        onFailure = { error ->
            safeStringLogger.error(error) { "[RES_FALLBACK] fallo al decodificar id=$id" }
        }
    )

internal inline fun <T> safeResource(
    load: () -> T,
    fallback: T,
    onFailure: (Throwable) -> Unit,
): T =
    runCatching(load)
        .onFailure(onFailure)
        .getOrElse { fallback }

