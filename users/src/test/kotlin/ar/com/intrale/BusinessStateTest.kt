package ar.com.intrale
import ar.com.intrale.BusinessState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BusinessStateTest {
    @Test
    fun valuesContainExpectedStates() {
        val states = BusinessState.values().map { it.name }
        assertTrue("PENDING" in states)
        assertTrue("APPROVED" in states)
        assertTrue("REJECTED" in states)
        assertEquals(3, states.size)
    }

    @Test
    fun valueOfReturnsCorrectEnum() {
        assertEquals(BusinessState.PENDING, BusinessState.valueOf("PENDING"))
        assertEquals(BusinessState.APPROVED, BusinessState.valueOf("APPROVED"))
        assertEquals(BusinessState.REJECTED, BusinessState.valueOf("REJECTED"))
    }

    @Test
    fun toStringMatchesName() {
        BusinessState.values().forEach {
            assertEquals(it.name, it.toString())
        }
    }
}
