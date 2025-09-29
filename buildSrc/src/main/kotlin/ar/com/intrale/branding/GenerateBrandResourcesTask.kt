package ar.com.intrale.branding

import java.time.Duration
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

abstract class GenerateBrandResourcesTask : DefaultTask() {

    @get:Input
    abstract val brandIdentifier: Property<String>

    @get:Input
    abstract val appDisplayName: Property<String>

    @get:Input
    @get:Optional
    abstract val brandingEndpoint: Property<String>

    @get:Input
    @get:Optional
    abstract val brandingPreviewVersion: Property<String>

    @get:OutputDirectory
    abstract val outputResDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val brandStorageDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val brandId = brandIdentifier.get()
        val fallbackName = appDisplayName.get()
        val endpoint = brandingEndpoint.orNull?.takeIf { it.isNotBlank() }
        val previewVersion = brandingPreviewVersion.orNull?.takeIf { it.isNotBlank() }

        var appliedAppName = fallbackName
        var downloadedJson: String? = null

        if (endpoint != null) {
            try {
                val result = fetchBrandingEnvelope(
                    endpoint = endpoint,
                    brandId = brandId,
                    previewVersion = previewVersion,
                    timeout = Duration.ofSeconds(10)
                )
                downloadedJson = result.rawJson
                val remoteAppName = result.envelope.payload.appName.trim()
                if (remoteAppName.isNotEmpty()) {
                    appliedAppName = remoteAppName
                    logger.lifecycle(
                        "Branding remoto aplicado para $brandId con appName=\"${appliedAppName.escapeForXmlText()}\""
                    )
                } else {
                    logger.warn(
                        "WARNING: El branding remoto de $brandId no incluye payload.appName válido. " +
                            "Se utilizará el valor local \"${fallbackName.escapeForXmlText()}\""
                    )
                }
            } catch (ex: Exception) {
                logger.warn(
                    "WARNING: No se pudo obtener branding remoto para $brandId desde $endpoint. " +
                        "Se usará el fallback local \"${fallbackName.escapeForXmlText()}\". Detalle: ${ex.message}"
                )
            }
        }

        val valuesDir = outputResDirectory.get().dir("values").asFile.also { it.mkdirs() }
        val stringsFile = valuesDir.resolve("strings.xml")

        val content = """
            <?xml version="1.0" encoding="utf-8"?>
            <resources>
                <string name="app_name">${appliedAppName.escapeForXmlText()}</string>
            </resources>
        """.trimIndent() + "\n"

        logger.lifecycle("Generando recursos de marca para $brandId en ${stringsFile.absolutePath}")
        stringsFile.writeText(content)

        val brandValuesDir = brandStorageDirectory.get().dir("values").asFile.also { it.mkdirs() }
        brandValuesDir.resolve("strings.xml").writeText(content)

        downloadedJson?.let { raw ->
            val storageRoot = brandValuesDir.parentFile ?: brandValuesDir
            val jsonFile = storageRoot.resolve("branding.json")
            jsonFile.parentFile?.mkdirs()
            jsonFile.writeText(raw)
            logger.lifecycle("Branding remoto almacenado en ${jsonFile.absolutePath}")
        }
    }

    private fun String.escapeForXmlText(): String = this
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")
}
