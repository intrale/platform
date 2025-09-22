package ui.util

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.test.Test
import kotlin.test.assertEquals

class SafeResourceTest {

    @OptIn(ExperimentalEncodingApi::class)
    @Test
    fun `decodeIfBase64OrReturn decodes valid payload`() {
        val original = "Dashboard"
        val encoded = Base64.encode(original.encodeToByteArray())

        val result = decodeIfBase64OrReturn(encoded)

        assertEquals(original, result)
    }

    @Test
    fun `decodeIfBase64OrReturn returns original when input is not Base64`() {
        val original = "Texto plano sin codificar"

        val result = decodeIfBase64OrReturn(original)

        assertEquals(original, result)
    }

    @Test
    fun `decodeIfBase64OrReturn ignora cadenas inválidas`() {
        val invalid = "Zm9vYmFy==\n"

        val result = decodeIfBase64OrReturn(invalid)

        assertEquals(invalid, result)
    }
}
