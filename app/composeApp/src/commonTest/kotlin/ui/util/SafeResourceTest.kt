package ui.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SafeResourceTest {

    @Test
    fun `returns loaded value when no failure happens`() {
        val result = safeResource(
            load = { "ok" },
            fallback = "fallback",
            onFailure = { error -> error.printStackTrace() },
        )

        assertEquals("ok", result)
    }

    @Test
    fun `returns fallback and reports error when load throws`() {
        val recorded = mutableListOf<Throwable>()

        val result = safeResource(
            load = { error("boom") },
            fallback = "fallback",
            onFailure = { recorded += it },
        )

        assertEquals("fallback", result)
        assertEquals(1, recorded.size)
        assertTrue(recorded.first() is IllegalStateException)
        assertEquals("boom", recorded.first().message)
    }
}
