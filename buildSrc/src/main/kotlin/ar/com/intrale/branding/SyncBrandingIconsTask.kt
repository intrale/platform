package ar.com.intrale.branding

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.Comparator

@CacheableTask
abstract class SyncBrandingIconsTask : DefaultTask() {

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val packDirectory: DirectoryProperty

    @get:Internal
    abstract val projectRoot: DirectoryProperty

    @TaskAction
    fun sync() {
        val packDirPath = packDirectory.asFile.get().toPath()
        if (!Files.exists(packDirPath)) {
            throw GradleException("⚠️ No existe $packDirPath")
        }

        val rootPath = projectRoot.asFile.get().toPath()
        val decoder = Base64.getMimeDecoder()
        val updated = mutableListOf<Path>()

        Files.walk(packDirPath).use { stream ->
            stream.filter { Files.isRegularFile(it) && it.fileName.toString().endsWith(".b64") }
                .sorted(Comparator.comparing { it.toString() })
                .forEach { b64Path ->
                    val relative = packDirPath.relativize(b64Path)
                    val target = rootPath.resolve(relative.toString().removeSuffix(".b64"))
                    Files.createDirectories(target.parent)
                    val decoded = decoder.decode(Files.readString(b64Path).trim())
                    val changed = if (Files.exists(target)) {
                        !Files.readAllBytes(target).contentEquals(decoded)
                    } else {
                        true
                    }
                    if (changed) {
                        Files.write(target, decoded)
                        updated.add(relative)
                    }
                }
        }

        if (updated.isEmpty()) {
            logger.lifecycle("ℹ️ Los íconos ya estaban actualizados")
        } else {
            updated.forEach { path ->
                logger.lifecycle("✅ Generado ${path.toString().removeSuffix(".b64")}")
            }
        }
    }
}
