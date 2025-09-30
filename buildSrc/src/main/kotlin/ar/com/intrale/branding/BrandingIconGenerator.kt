package ar.com.intrale.branding

import java.awt.AlphaComposite
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.util.Locale
import javax.imageio.ImageIO
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import org.gradle.api.logging.Logger

private const val MAX_LOGO_BYTES = 512 * 1024
private val ALLOWED_MIME_TYPES = setOf("image/png", "image/jpeg", "image/jpg")
private val ICON_DENSITIES = linkedMapOf(
    "mipmap-mdpi" to 108,
    "mipmap-hdpi" to 162,
    "mipmap-xhdpi" to 216,
    "mipmap-xxhdpi" to 324,
    "mipmap-xxxhdpi" to 432,
)
private const val CONTENT_SCALE = 0.76
private const val DOWNLOAD_TIMEOUT_MILLIS = 10_000

class BrandingIconGenerator(private val logger: Logger) {

    init {
        System.setProperty("java.awt.headless", "true")
    }

    fun generate(
        resourcesDir: File,
        storageDir: File,
        params: IconGenerationParams,
    ): IconGenerationResult {
        resourcesDir.mkdirs()
        storageDir.mkdirs()

        val artworkResult = resolveArtwork(params, storageDir)
        val backgroundColor = resolveBackgroundColor(params, artworkResult.artwork)
        val generated = mutableListOf<File>()

        ICON_DENSITIES.forEach { (folder, size) ->
            val outputDir = resourcesDir.resolve(folder).also { it.mkdirs() }
            val storageOutputDir = storageDir.resolve(folder).also { it.mkdirs() }
            val rendered = renderAdaptiveIcon(size, backgroundColor, artworkResult.artwork)

            val foreground = outputDir.resolve("ic_launcher_foreground.png")
            val legacy = outputDir.resolve("ic_launcher.png")
            val round = outputDir.resolve("ic_launcher_round.png")
            writePng(rendered, foreground)
            writePng(rendered, legacy)
            writePng(rendered, round)

            val storageForeground = storageOutputDir.resolve("ic_launcher_foreground.png")
            val storageLegacy = storageOutputDir.resolve("ic_launcher.png")
            val storageRound = storageOutputDir.resolve("ic_launcher_round.png")
            writePng(rendered, storageForeground)
            writePng(rendered, storageLegacy)
            writePng(rendered, storageRound)

            generated += listOf(foreground, legacy, round)
        }

        val anydpiDir = resourcesDir.resolve("mipmap-anydpi-v26").also { it.mkdirs() }
        val storageAnydpiDir = storageDir.resolve("mipmap-anydpi-v26").also { it.mkdirs() }
        val adaptiveXml = buildAdaptiveIconXml()
        val adaptiveFile = anydpiDir.resolve("ic_launcher.xml")
        val adaptiveRoundFile = anydpiDir.resolve("ic_launcher_round.xml")
        adaptiveFile.writeText(adaptiveXml)
        adaptiveRoundFile.writeText(adaptiveXml)
        storageAnydpiDir.resolve("ic_launcher.xml").writeText(adaptiveXml)
        storageAnydpiDir.resolve("ic_launcher_round.xml").writeText(adaptiveXml)
        generated += listOf(adaptiveFile, adaptiveRoundFile)

        val valuesDir = resourcesDir.resolve("values").also { it.mkdirs() }
        val storageValuesDir = storageDir.resolve("values").also { it.mkdirs() }
        val backgroundColorHex = backgroundColor.toHex()
        val colorXml = buildColorXml(backgroundColorHex)
        val colorFile = valuesDir.resolve("ic_launcher_brand.xml")
        val storageColorFile = storageValuesDir.resolve("ic_launcher_brand.xml")
        colorFile.writeText(colorXml)
        storageColorFile.writeText(colorXml)
        generated += colorFile

        when {
            artworkResult.usedPlaceholder -> {
                val reason = artworkResult.reason.orEmpty()
                logger.warn(
                    "WARNING: Se utilizó un placeholder para el ícono de ${params.brandId}. $reason"
                )
            }
            artworkResult.logoSource != null -> {
                logger.lifecycle(
                    "Ícono adaptive generado con logo remoto (${artworkResult.logoSource})."
                )
            }
            else -> {
                logger.lifecycle("Ícono adaptive generado con recurso local.")
            }
        }

        return IconGenerationResult(
            usedPlaceholder = artworkResult.usedPlaceholder,
            placeholderReason = artworkResult.reason,
            generatedFiles = generated,
        )
    }

    private fun resolveArtwork(
        params: IconGenerationParams,
        storageDir: File,
    ): ArtworkResult {
        val logo = params.logo
        if (logo != null) {
            val attempt = tryLoadLogo(logo)
            if (attempt != null) {
                val normalized = normalizeToSquare(attempt.image)
                persistOriginalLogo(storageDir, attempt)
                persistNormalizedLogo(storageDir, normalized)
                return ArtworkResult(
                    artwork = IconArtwork.Logo(normalized),
                    usedPlaceholder = false,
                    reason = null,
                    logoSource = attempt.url,
                )
            }
        }

        val initials = computeInitials(params.displayName.ifBlank { params.fallbackName }, params.brandId)
        return ArtworkResult(
            artwork = IconArtwork.Placeholder(initials = initials),
            usedPlaceholder = true,
            reason = buildPlaceholderReason(logo),
            logoSource = null,
        )
    }

    private fun tryLoadLogo(logo: BrandingImage): DownloadedLogo? {
        val url = logo.url?.trim().orEmpty()
        if (url.isEmpty()) {
            return null
        }

        val declaredMime = logo.mimeType?.lowercase(Locale.ROOT)
        if (declaredMime != null && declaredMime !in ALLOWED_MIME_TYPES) {
            return null
        }

        return try {
            downloadLogo(url, declaredMime)
        } catch (ex: Exception) {
            logger.warn("WARNING: No se pudo descargar el logo remoto desde $url. ${ex.message}")
            null
        }
    }

    private fun downloadLogo(url: String, declaredMime: String?): DownloadedLogo? {
        val connection = (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            connectTimeout = DOWNLOAD_TIMEOUT_MILLIS
            readTimeout = DOWNLOAD_TIMEOUT_MILLIS
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "IntraleBranding/1.0")
        }

        return try {
            connection.inputStream.use { input ->
                if (connection.responseCode !in 200..299) {
                    throw IllegalStateException("HTTP ${connection.responseCode}")
                }

                val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
                val effectiveMime = declaredMime ?: contentType
                if (effectiveMime != null && effectiveMime !in ALLOWED_MIME_TYPES) {
                    throw IllegalStateException("MIME no permitido: $effectiveMime")
                }

                val buffer = ByteArrayOutputStream()
                val data = ByteArray(8_192)
                while (true) {
                    val read = input.read(data)
                    if (read == -1) break
                    buffer.write(data, 0, read)
                    if (buffer.size() > MAX_LOGO_BYTES) {
                        throw IllegalStateException("El logo supera el límite de ${MAX_LOGO_BYTES / 1024} KB")
                    }
                }

                val bytes = buffer.toByteArray()
                val image = ImageIO.read(ByteArrayInputStream(bytes))
                    ?: throw IllegalStateException("Formato de imagen no soportado")
                DownloadedLogo(
                    url = url,
                    bytes = bytes,
                    mimeType = effectiveMime ?: "image/png",
                    image = toArgb(image),
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun renderAdaptiveIcon(
        size: Int,
        background: Color,
        artwork: IconArtwork,
    ): BufferedImage {
        val image = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
        val graphics = image.createGraphics()
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC)
        graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        graphics.color = background
        graphics.fillRect(0, 0, size, size)

        when (artwork) {
            is IconArtwork.Logo -> {
                val logo = artwork.image
                val maxContent = (size * CONTENT_SCALE).roundToInt()
                val ratio = min(
                    maxContent.toDouble() / logo.width,
                    maxContent.toDouble() / logo.height,
                )
                val targetWidth = max(1, (logo.width * ratio).roundToInt())
                val targetHeight = max(1, (logo.height * ratio).roundToInt())
                val x = (size - targetWidth) / 2
                val y = (size - targetHeight) / 2
                graphics.drawImage(logo, x, y, targetWidth, targetHeight, null)
            }
            is IconArtwork.Placeholder -> {
                val initials = artwork.initials
                val textColor = choosePlaceholderTextColor(background)
                graphics.color = textColor
                val fontSize = (size * 0.48).roundToInt()
                val font = Font("SansSerif", Font.BOLD, fontSize)
                graphics.font = font
                val metrics = graphics.fontMetrics
                val textWidth = metrics.stringWidth(initials)
                val ascent = metrics.ascent
                val descent = metrics.descent
                val x = (size - textWidth) / 2
                val y = (size + ascent - descent) / 2
                graphics.drawString(initials, x, y)
            }
        }

        graphics.dispose()
        return image
    }

    private fun normalizeToSquare(image: BufferedImage): BufferedImage {
        if (image.width == image.height && image.type == BufferedImage.TYPE_INT_ARGB) {
            return image
        }
        val size = max(image.width, image.height)
        val square = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
        val g = square.createGraphics()
        g.composite = AlphaComposite.Src
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC)
        val offsetX = (size - image.width) / 2
        val offsetY = (size - image.height) / 2
        g.drawImage(image, offsetX, offsetY, null)
        g.dispose()
        return square
    }

    private fun toArgb(image: BufferedImage): BufferedImage {
        return if (image.type == BufferedImage.TYPE_INT_ARGB) {
            image
        } else {
            val converted = BufferedImage(image.width, image.height, BufferedImage.TYPE_INT_ARGB)
            val g = converted.createGraphics()
            g.drawImage(image, 0, 0, null)
            g.dispose()
            converted
        }
    }

    private fun persistOriginalLogo(storageDir: File, logo: DownloadedLogo) {
        val extension = when (logo.mimeType.lowercase(Locale.ROOT)) {
            "image/png" -> "png"
            "image/jpeg", "image/jpg" -> "jpg"
            else -> "bin"
        }
        val rawDir = storageDir.resolve("raw").also { it.mkdirs() }
        Files.write(rawDir.resolve("logo_original.$extension").toPath(), logo.bytes)
    }

    private fun persistNormalizedLogo(storageDir: File, normalized: BufferedImage) {
        val rawDir = storageDir.resolve("raw").also { it.mkdirs() }
        val file = rawDir.resolve("logo_normalized.png")
        writePng(normalized, file)
    }

    private fun writePng(image: BufferedImage, file: File) {
        file.parentFile?.mkdirs()
        ImageIO.write(image, "png", file)
    }

    private fun resolveBackgroundColor(
        params: IconGenerationParams,
        artwork: IconArtwork,
    ): Color {
        val primary = params.palette?.primary?.let(::parseColor)
        if (primary != null) {
            return primary
        }
        val seed = (params.displayName.ifBlank { params.fallbackName }.ifBlank { params.brandId })
        return deriveColorFromSeed(seed + if (artwork is IconArtwork.Placeholder) "placeholder" else "logo")
    }

    private fun parseColor(value: String): Color? {
        val sanitized = value.trim()
        if (!sanitized.startsWith("#")) return null
        val hex = sanitized.substring(1)
        return when (hex.length) {
            6 -> {
                val rgb = hex.toIntOrNull(16) ?: return null
                Color((rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF)
            }
            8 -> {
                val argb = hex.toLongOrNull(16) ?: return null
                Color(
                    ((argb shr 16) and 0xFF).toInt(),
                    ((argb shr 8) and 0xFF).toInt(),
                    (argb and 0xFF).toInt(),
                    ((argb shr 24) and 0xFF).toInt(),
                )
            }
            else -> null
        }
    }

    private fun deriveColorFromSeed(seed: String): Color {
        val hash = seed.hashCode()
        val hue = ((hash and 0x7FFFFFFF) % 360) / 360f
        val saturation = 0.55f
        val brightness = 0.85f
        return Color.getHSBColor(hue, saturation, brightness)
    }

    private fun choosePlaceholderTextColor(background: Color): Color {
        val luminance = (0.299 * background.red + 0.587 * background.green + 0.114 * background.blue) / 255
        return if (luminance < 0.6) Color.WHITE else Color(0x22, 0x2B, 0x45)
    }

    private fun computeInitials(name: String, fallback: String): String {
        val tokens = name.split(Regex("\\s+"))
            .filter { it.isNotBlank() }
        if (tokens.isNotEmpty()) {
            val initials = tokens.take(2).joinToString(separator = "") { token ->
                token.first().uppercaseChar().toString()
            }
            if (initials.isNotBlank()) {
                return initials
            }
        }
        return fallback.take(2).uppercase(Locale.ROOT)
    }

    private fun buildPlaceholderReason(logo: BrandingImage?): String = when {
        logo == null -> "No se encontró referencia de logo en el branding."
        logo.url.isNullOrBlank() -> "El payload.images.logo.url está vacío."
        logo.mimeType != null && logo.mimeType.lowercase(Locale.ROOT) !in ALLOWED_MIME_TYPES ->
            "El MIME type ${logo.mimeType} no es válido."
        else -> "No fue posible descargar o decodificar el logo remoto."
    }

    private fun buildAdaptiveIconXml(): String = """
        <?xml version="1.0" encoding="utf-8"?>
        <adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
            <background android:drawable="@color/ic_launcher_background" />
            <foreground android:drawable="@mipmap/ic_launcher_foreground" />
        </adaptive-icon>
    """.trimIndent() + "\n"

    private fun buildColorXml(color: String): String = """
        <?xml version="1.0" encoding="utf-8"?>
        <resources>
            <color name="ic_launcher_background">$color</color>
        </resources>
    """.trimIndent() + "\n"

    private fun Color.toHex(): String {
        val argb = (alpha shl 24) or (red shl 16) or (green shl 8) or blue
        return "#%08X".format(Locale.ROOT, argb)
    }
}

data class IconGenerationParams(
    val brandId: String,
    val displayName: String,
    val fallbackName: String,
    val palette: BrandingPalette?,
    val logo: BrandingImage?,
)

data class IconGenerationResult(
    val usedPlaceholder: Boolean,
    val placeholderReason: String?,
    val generatedFiles: List<File>,
)

private sealed class IconArtwork {
    data class Logo(val image: BufferedImage) : IconArtwork()
    data class Placeholder(val initials: String) : IconArtwork()
}

private data class DownloadedLogo(
    val url: String,
    val bytes: ByteArray,
    val mimeType: String,
    val image: BufferedImage,
)

private data class ArtworkResult(
    val artwork: IconArtwork,
    val usedPlaceholder: Boolean,
    val reason: String?,
    val logoSource: String?,
)
