package ar.com.intrale.util

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

private val BASE64_REGEX = Regex("^[A-Za-z0-9+/]+={0,2}$")

@OptIn(ExperimentalEncodingApi::class)
fun decodeBase64OrNull(raw: String): String? {
    val candidate = raw.trim()
    if (candidate.isEmpty()) return candidate
    if (candidate.contains('\n') || candidate.contains('\r')) return null
    if (candidate.length % 4 != 0) return null
    if (!BASE64_REGEX.matches(candidate)) return null

    return runCatching {
        Base64.decode(candidate).decodeToString()
    }.getOrNull()
}
