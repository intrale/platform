package openapi

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction

/**
 * Tarea Gradle que valida la consistencia entre el spec OpenAPI y los bindings de Kodein.
 *
 * Falla el build si:
 * - Hay un binding bind<Function>(tag="xxx") en Modules.kt sin path correspondiente en openapi.yaml.
 * - Hay un path en openapi.yaml sin binding en Modules.kt que lo cubra.
 *
 * Configuración en build.gradle.kts:
 * ```
 * val validateOpenApi by tasks.registering(ValidateOpenApiTask::class) {
 *     openapiFile.set(rootProject.layout.projectDirectory.file("docs/api/openapi.yaml"))
 *     modulesFile.set(rootProject.layout.projectDirectory.file("users/src/.../Modules.kt"))
 * }
 * tasks.named("check").configure { dependsOn(validateOpenApi) }
 * ```
 */
abstract class ValidateOpenApiTask : DefaultTask() {

    @get:InputFile
    abstract val openapiFile: RegularFileProperty

    @get:InputFile
    abstract val modulesFile: RegularFileProperty

    @get:OutputFile
    val stampFile: RegularFileProperty = project.objects.fileProperty().convention(
        project.layout.buildDirectory.file("validateOpenApi/result.txt"),
    )

    @TaskAction
    fun validate() {
        val result = OpenApiValidator.validate(
            openapiFile.get().asFile,
            modulesFile.get().asFile,
        )

        if (result.errors.isNotEmpty()) {
            val details = result.errors.joinToString("\n") { error ->
                "  ${error.message}:\n" + error.items.joinToString("\n") { "    - $it" }
            }
            throw GradleException("validateOpenApi falló:\n$details")
        }

        val stamp = stampFile.get().asFile
        stamp.parentFile.mkdirs()
        stamp.writeText(
            "OK — ${result.pathsFound} paths, ${result.bindingsFound} bindings — ${java.time.Instant.now()}",
        )
    }
}
