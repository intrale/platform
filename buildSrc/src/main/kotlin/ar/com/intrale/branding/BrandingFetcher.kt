package ar.com.intrale.branding

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.Locale
import kotlin.io.use

data class BrandingFetchResult(
    val envelope: BrandingEnvelope,
    val rawJson: String
)

fun fetchBrandingEnvelope(
    endpoint: String,
    brandId: String,
    previewVersion: String? = null,
    timeout: Duration = Duration.ofSeconds(10),
    headers: Map<String, String> = emptyMap(),
    parser: BrandingParser = BrandingParser(),
    httpFetcher: (url: String, headers: Map<String, String>, timeout: Duration) -> BrandingHttpResponse = ::defaultBrandingHttpFetch,
): BrandingFetchResult {
    val url = buildBrandingUrl(endpoint, brandId, previewVersion)
    val response = httpFetcher(url, headers, timeout)

    if (!response.successful) {
        throw IllegalStateException("Respuesta inválida (${response.code}) al descargar branding desde $url")
    }

    val envelope = try {
        parser.parseEnvelope(response.body)
    } catch (ex: Exception) {
        throw IllegalStateException("El JSON de branding recibido no es válido", ex)
    }

    return BrandingFetchResult(envelope = envelope, rawJson = response.body)
}

private fun defaultBrandingHttpFetch(
    url: String,
    headers: Map<String, String>,
    timeout: Duration,
): BrandingHttpResponse = BrandingHttpClient(timeout).use { client ->
    client.fetch(url, headers)
}

private fun buildBrandingUrl(
    endpoint: String,
    brandId: String,
    previewVersion: String?,
): String {
    val sanitized = endpoint.trim()
    require(sanitized.isNotEmpty()) { "El endpoint de branding es obligatorio" }

    val base = when {
        sanitized.contains("{brandId}") -> sanitized.replace("{brandId}", brandId)
        sanitized.contains("{{brandId}}") -> sanitized.replace("{{brandId}}", brandId)
        sanitized.contains("%s") -> String.format(Locale.ROOT, sanitized, brandId)
        else -> sanitized.trimEnd('/') + "/" + brandId
    }

    val preview = previewVersion?.takeIf { it.isNotBlank() } ?: return base
    val encodedPreview = URLEncoder.encode(preview, StandardCharsets.UTF_8)
    val separator = if (base.contains('?')) '&' else '?'
    return base + separator + "previewVersion=" + encodedPreview
}
