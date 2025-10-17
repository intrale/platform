@file:OptIn(ExperimentalResourceApi::class)

package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource

@Composable
actual fun resString(
    androidId: Int?,
    composeId: StringResource?,
    fallbackAsciiSafe: String,
): String {
    val identifier = "androidId=$androidId composeId=$composeId"

    val resolvedAndroidId = androidId ?: composeId?.let(::androidIdFromCompose)

    resolvedAndroidId?.let { id ->
        return runCatching { stringResource(id) }
            .getOrElse { error ->
                logFallback(identifier, fallbackAsciiSafe, error)
            }
    }

    if (composeId != null) {
        val guessedKey = composeKey(composeId)
        val message = buildString {
            append("Missing Android string for composeId=")
            append(composeId)
            if (guessedKey != null) {
                append(" key=")
                append(guessedKey)
            }
        }
        return logFallback(message, fallbackAsciiSafe)
    }

    return logFallback(identifier, fallbackAsciiSafe)
}

private fun androidIdFromCompose(resource: StringResource): Int? {
    return composeKey(resource)?.let(::androidStringId)
}

private fun composeKey(resource: StringResource): String? {
    return runCatching { resource.key }.getOrNull()
}
