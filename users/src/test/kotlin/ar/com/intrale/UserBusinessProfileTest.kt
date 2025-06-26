package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals

class UserBusinessProfileTest {
    @Test
    fun `compositeKey se actualiza con los valores asignados`() {
        val profile = UserBusinessProfile()
        profile.email = "user@test.com"
        profile.business = "biz"
        profile.profile = "ADMIN"
        assertEquals("user@test.com#biz#ADMIN", profile.compositeKey)
    }

    @Test
    fun `cambiar alguna propiedad actualiza el compositeKey`() {
        val profile = UserBusinessProfile().apply {
            email = "user@test.com"
            business = "biz"
            profile = "CLIENT"
        }
        profile.business = "newbiz"
        assertEquals("user@test.com#newbiz#CLIENT", profile.compositeKey)
    }

    @Test
    fun `solo email genera compositeKey parcial`() {
        val profile = UserBusinessProfile()
        profile.email = "user@test.com"
        assertEquals("user@test.com##", profile.compositeKey)
    }
}
