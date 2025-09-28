package ar.com.intrale.branding

import java.time.Duration
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction

@CacheableTask
abstract class BrandingGeneratorTask : DefaultTask() {

    @get:Input
    abstract val brandingUrl: Property<String>

    @get:Input
    abstract val timeoutMillis: Property<Long>

    @get:Input
    abstract val headers: MapProperty<String, String>

    @get:OutputFile
    abstract val outputFile: RegularFileProperty

    @get:Internal
    protected open val parser: BrandingParser = BrandingParser()

    init {
        timeoutMillis.convention(10_000L)
        headers.convention(emptyMap())
    }

    @TaskAction
    fun generate() {
        val url = brandingUrl.orNull ?: throw GradleException("Debe configurarse `brandingUrl` para BrandingGeneratorTask")
        val timeout = Duration.ofMillis(timeoutMillis.get())

        val response = try {
            BrandingHttpClient(timeout).use { client ->
                client.fetch(url, headers.getOrElse(emptyMap()))
            }
        } catch (ex: Exception) {
            throw GradleException("No fue posible descargar el branding desde $url", ex)
        }

        if (!response.successful) {
            throw GradleException("Respuesta inválida (${response.code}) al descargar branding desde $url")
        }

        val envelope = try {
            parser.parseEnvelope(response.body)
        } catch (ex: Exception) {
            throw GradleException("El JSON de branding recibido no es válido", ex)
        }

        val output = outputFile.asFile.get()
        output.parentFile?.mkdirs()
        output.writeText(parser.toJson(envelope))

        logger.lifecycle(
            "✅ Branding ${envelope.payload.appName} v${envelope.version} almacenado en ${output.absolutePath}"
        )
    }
}
