package ar.com.intrale.branding

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

class BrandingParser(
    private val json: Json = Json {
        ignoreUnknownKeys = true
        prettyPrint = false
    }
) {

    fun parseEnvelope(raw: String): BrandingEnvelope {
        val root = json.parseToJsonElement(raw).jsonObject

        val payload = root["payload"]?.jsonObject
            ?: error("El payload es obligatorio en la respuesta de branding")

        return BrandingEnvelope(
            version = root["version"]?.jsonPrimitive?.intOrNull
                ?: error("El campo version es obligatorio"),
            schemaVersion = root["schemaVersion"]?.jsonPrimitive?.intOrNull
                ?: 0,
            payload = parsePayload(payload)
        )
    }

    fun toJson(envelope: BrandingEnvelope): String {
        val element = buildJsonObject {
            put("version", envelope.version)
            put("schemaVersion", envelope.schemaVersion)
            putJsonObject("payload") {
                put("appName", envelope.payload.appName)
                envelope.payload.palette?.let { palette ->
                    putJsonObject("palette") {
                        put("primary", palette.primary)
                        put("onPrimary", palette.onPrimary)
                        palette.surface?.let { put("surface", it) }
                        palette.onSurface?.let { put("onSurface", it) }
                        palette.primaryVariant?.let { put("primaryVariant", it) }
                    }
                }
                envelope.payload.typography?.let { typography ->
                    putJsonObject("typography") {
                        typography.headline?.let { put("headline", it) }
                        typography.body?.let { put("body", it) }
                        typography.caption?.let { put("caption", it) }
                    }
                }
            }
        }

        return json.encodeToString(JsonObject.serializer(), element)
    }

    private fun parsePayload(payload: JsonObject): BrandingConfigMinimal {
        val palette = payload["palette"]?.jsonObject?.let(::parsePalette)
        val typography = payload["typography"]?.jsonObject?.let(::parseTypography)

        return BrandingConfigMinimal(
            appName = payload["appName"]?.jsonPrimitive?.content
                ?: error("El campo appName es obligatorio en el payload"),
            palette = palette,
            typography = typography
        )
    }

    private fun parsePalette(palette: JsonObject): BrandingPalette {
        val primary = palette["primary"]?.jsonPrimitive?.content
            ?: error("El color primary es obligatorio para la paleta")
        val onPrimary = palette["onPrimary"]?.jsonPrimitive?.content
            ?: error("El color onPrimary es obligatorio para la paleta")

        return BrandingPalette(
            primary = primary,
            onPrimary = onPrimary,
            surface = palette["surface"]?.jsonPrimitive?.contentOrNull(),
            onSurface = palette["onSurface"]?.jsonPrimitive?.contentOrNull(),
            primaryVariant = palette["primaryVariant"]?.jsonPrimitive?.contentOrNull()
        )
    }

    private fun parseTypography(typography: JsonObject): BrandingTypography =
        BrandingTypography(
            headline = typography["headline"]?.jsonPrimitive?.contentOrNull(),
            body = typography["body"]?.jsonPrimitive?.contentOrNull(),
            caption = typography["caption"]?.jsonPrimitive?.contentOrNull()
        )
}

private fun JsonElement.contentOrNull(): String? = when (this) {
    is JsonNull -> null
    else -> this.jsonPrimitive.content
}
