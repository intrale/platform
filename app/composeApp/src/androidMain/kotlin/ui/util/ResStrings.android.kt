package ui.util

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource as composeStringResource
import kotlin.text.Charsets

private const val RES_STRINGS_TAG = "ResStrings"
private val base64CandidateRegex = Regex("^[A-Za-z0-9+/=_-]+$")

@Composable
actual fun resString(
    androidId: Int?,
    composeId: StringResource?,
    fallbackAsciiSafe: String,
): String {
    val context: Context = LocalContext.current
    val identifier = "androidId=$androidId composeId=$composeId"

    androidId?.let { id ->
        return resolveOrFallback(
            identifier = identifier,
            resolver = { context.getString(id) },
            fallback = fallbackAsciiSafe,
        )
    }

    composeId?.let { cid ->
        logComposeId(identifier)
        return resolveComposeOrFallback(
            identifier = identifier,
            fallback = fallbackAsciiSafe,
        ) {
            val resolved = composeStringResource(cid)
            decodeIfBase64OrReturn(identifier, resolved)
        }
    }

    return logFallback(identifier, fallbackAsciiSafe)
}

@Composable
private fun resolveComposeOrFallback(
    identifier: String,
    fallback: String,
    onFailure: (Throwable) -> Unit = {},
    resolver: @Composable () -> String,
): String {
    return runCatching { resolver() }
        .getOrElse { error ->
            onFailure(error)
            logFallback(identifier, fallback, error)
        }
}

private fun logComposeId(identifier: String) {
    Log.d(RES_STRINGS_TAG, "Resolviendo composeId=$identifier")
}

private fun decodeIfBase64OrReturn(identifier: String, value: String): String {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return value
    if (!base64CandidateRegex.matches(trimmed)) {
        return value
    }

    return decodeBase64OrNull(identifier, trimmed) ?: value
}

private fun decodeBase64OrNull(identifier: String, rawValue: String): String? {
    return runCatching {
        String(Base64.decode(rawValue, Base64.DEFAULT), Charsets.UTF_8)
    }.getOrElse { error ->
        Log.e(RES_STRINGS_TAG, "composeId=$identifier - valor inválido", error)
        null
    }
}
