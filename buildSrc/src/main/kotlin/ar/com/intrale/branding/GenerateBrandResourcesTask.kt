package ar.com.intrale.branding

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction

abstract class GenerateBrandResourcesTask : DefaultTask() {

    @get:Input
    abstract val brandIdentifier: Property<String>

    @get:Input
    abstract val appDisplayName: Property<String>

    @get:OutputDirectory
    abstract val outputResDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val brandStorageDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val valuesDir = outputResDirectory.get().dir("values").asFile.also { it.mkdirs() }
        val stringsFile = valuesDir.resolve("strings.xml")

        val content = """
            <?xml version="1.0" encoding="utf-8"?>
            <resources>
                <string name="app_name">${appDisplayName.get().escapeForXmlText()}</string>
            </resources>
        """.trimIndent() + "\n"

        logger.lifecycle("Generando recursos de marca para ${brandIdentifier.get()} en ${stringsFile.absolutePath}")
        stringsFile.writeText(content)

        val brandValuesDir = brandStorageDirectory.get().dir("values").asFile.also { it.mkdirs() }
        brandValuesDir.resolve("strings.xml").writeText(content)
    }

    private fun String.escapeForXmlText(): String = this
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")
}
