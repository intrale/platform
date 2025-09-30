package ar.com.intrale.branding

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertTrue
import org.gradle.api.logging.Logging

class BrandingIconGeneratorTest {

    @Test
    fun `genera placeholder y archivos esperados cuando no hay logo`() {
        val resourcesDir = createTempDirectory(prefix = "icons-res-").toFile()
        val storageDir = createTempDirectory(prefix = "icons-cache-").toFile()

        val generator = BrandingIconGenerator(Logging.getLogger("BrandingIconGeneratorTest"))
        val result = generator.generate(
            resourcesDir = resourcesDir,
            storageDir = storageDir,
            params = IconGenerationParams(
                brandId = "intrale",
                displayName = "Intrale Pagos",
                fallbackName = "Intrale",
                palette = BrandingPalette(
                    primary = "#223355",
                    onPrimary = "#FFFFFF",
                ),
                logo = null,
            )
        )

        assertTrue(result.usedPlaceholder, "Sin logo debe generar placeholder")
        val mipmapMdpi = File(resourcesDir, "mipmap-mdpi/ic_launcher_foreground.png")
        val xml = File(resourcesDir, "mipmap-anydpi-v26/ic_launcher.xml")
        val colors = File(resourcesDir, "values/ic_launcher_brand.xml")
        assertTrue(mipmapMdpi.exists(), "Debe generarse el PNG de foreground")
        assertTrue(xml.exists(), "Debe generarse el adaptive icon XML")
        assertTrue(colors.exists(), "Debe generarse el color de fondo")
    }
}
