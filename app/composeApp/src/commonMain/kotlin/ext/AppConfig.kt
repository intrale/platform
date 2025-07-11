package ext

import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.resource

@OptIn(ExperimentalResourceApi::class)
object AppConfig {
    val baseUrl: String by lazy {
        val text = resource("config.properties").readBytes().decodeToString()
        text.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.startsWith("baseUrl=") }
            ?.substringAfter("=")
            ?.trim()
            ?: ""
    }
}
