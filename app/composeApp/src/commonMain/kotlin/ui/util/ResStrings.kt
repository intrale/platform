@file:OptIn(org.jetbrains.compose.resources.ExperimentalResourceApi::class)
@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")

package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import org.jetbrains.compose.resources.ResourceEnvironment
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.rememberResourceState
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

const val RES_ERROR_PREFIX = "⚠ "

private val resStringLogger: Logger = LoggerFactory.default.newLogger("ui.util", "ResStrings")

private object ResStringFallbackMetrics {
    private var fallbackCount: Int = 0

    fun registerFallback(): Int {
        fallbackCount += 1
        return fallbackCount
    }
}

internal var resourceStringResolver: suspend (ResourceEnvironment, StringResource) -> String =
    { environment, res -> getString(environment, res) }

@Composable
fun resStringOr(res: StringResource, fallback: String): String {
    val resolved by rememberResourceState(res, fallback, { fallback }) { environment ->
        resolveOrFallback(environment, res, fallback)
    }
    return resolved
}

internal suspend fun resolveOrFallback(
    resolver: suspend () -> String,
    fallback: String,
    onFailure: (Throwable) -> Unit = {}
): String {
    return runCatching { resolver() }
        .getOrElse { error ->
            onFailure(error)
            fallback
        }
}

internal suspend fun resolveOrFallback(
    environment: ResourceEnvironment,
    res: StringResource,
    fallback: String
): String {
    return resolveOrFallback(
        resolver = { resourceStringResolver(environment, res) },
        fallback = fallback
    ) { error ->
        val total = ResStringFallbackMetrics.registerFallback()
        resStringLogger.error(error) {
            "[RES_FALLBACK] id=${res} total=$total fallback=\"$fallback\""
        }
    }
}
