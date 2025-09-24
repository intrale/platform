package compose

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

abstract class ValidateComposeResourcesTask : DefaultTask() {

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val resourcesRoot: DirectoryProperty

    @TaskAction
    fun validate() {
        val directory = resourcesRoot.get().asFile
        val result = ResourcePackValidator.validate(directory)
        val uiRoot = project.rootProject.layout.projectDirectory.dir("app/composeApp/src").asFile
        val forbiddenImports = ResourcePackValidator.detectForbiddenBase64(uiRoot)
        val allErrors = result.errors + forbiddenImports

        if (allErrors.isNotEmpty()) {
            val details = buildString {
                appendLine("Se encontraron errores en los recursos generados por compose.resources:")
                allErrors.forEach { error ->
                    append(" - ")
                    append(error.file.relativeToOrSelf(project.projectDir))
                    if (error.lineNumber > 0) {
                        append(":${error.lineNumber}")
                    }
                    append(" → ")
                    appendLine(error.reason)
                }
            }
            throw GradleException(details.trim())
        }

        logger.lifecycle(
            "Validated ${result.validatedFiles} Compose resource pack(s) in ${directory.relativeToOrSelf(project.projectDir)}"
        )
    }
}
