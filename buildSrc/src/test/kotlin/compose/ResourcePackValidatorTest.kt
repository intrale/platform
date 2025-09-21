package compose

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ResourcePackValidatorTest {

    @Test
    fun `valid pack produces no errors`() {
        val tmp = createTempDirectory().toFile()
        val cvr = File(tmp, "sample.cvr")
        cvr.writeText(
            buildString {
                appendLine("version:0")
                appendLine("string|title|${java.util.Base64.getEncoder().encodeToString("Hola".toByteArray())}")
            }
        )

        val result = ResourcePackValidator.validate(tmp)

        assertEquals(1, result.validatedFiles)
        assertTrue(result.errors.isEmpty(), "Expected no validation errors but found: ${result.errors}")
    }

    @Test
    fun `invalid base64 is reported`() {
        val tmp = createTempDirectory().toFile()
        val cvr = File(tmp, "broken.cvr")
        cvr.writeText("string|bad|not-base64(")

        val result = ResourcePackValidator.validate(tmp)

        assertEquals(1, result.errors.size)
        assertTrue(result.errors.first().reason.contains("Base64 inválido"))
    }

    @Test
    fun `missing pack files is treated as error`() {
        val tmp = createTempDirectory().toFile()

        val result = ResourcePackValidator.validate(tmp)

        assertTrue(result.errors.isNotEmpty())
        assertTrue(result.errors.first().reason.contains("No se encontraron archivos"))
    }
}
