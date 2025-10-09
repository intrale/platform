package ar.com.intrale.branding

import org.gradle.api.DefaultTask
import org.gradle.api.tasks.TaskAction

abstract class GenerateBrandBuildsTask : DefaultTask() {
    init {
        group = "branding"
        description = "Genera builds placeholder por marca"
    }

    @TaskAction
    fun generate() {
        logger.lifecycle("generateBrandBuilds placeholder ejecutado")
    }
}
