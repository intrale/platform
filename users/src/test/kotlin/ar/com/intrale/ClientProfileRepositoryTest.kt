package ar.com.intrale

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClientProfileRepositoryTest {

    private val repository = ClientProfileRepository()

    @Test
    fun `solo una dirección queda marcada como predeterminada`() {
        val business = "intrale"
        val email = "client@example.com"

        val first = repository.createAddress(
            business,
            email,
            ClientAddressPayload(
                label = "Casa",
                street = "Calle 1",
                number = "123",
                city = "Buenos Aires",
                isDefault = true
            )
        )
        val second = repository.createAddress(
            business,
            email,
            ClientAddressPayload(
                label = "Oficina",
                street = "Oficina",
                number = "742",
                city = "Buenos Aires"
            )
        )

        val secondId = second.addresses.last().id!!
        repository.markDefault(business, email, secondId)

        val snapshot = repository.getSnapshot(business, email)
        assertEquals(secondId, snapshot.profile.defaultAddressId)
        assertEquals(1, snapshot.addresses.count { it.isDefault })
    }

    @Test
    fun `las direcciones se aíslan por negocio y usuario`() {
        repository.createAddress(
            "biz-a",
            "alpha@example.com",
            ClientAddressPayload(
                label = "Casa A",
                street = "Uno",
                number = "111",
                city = "CABA"
            )
        )
        repository.createAddress(
            "biz-b",
            "alpha@example.com",
            ClientAddressPayload(
                label = "Casa B",
                street = "Dos",
                number = "222",
                city = "CABA",
                isDefault = true
            )
        )

        val addressesBizA = repository.listAddresses("biz-a", "alpha@example.com")
        val addressesBizB = repository.listAddresses("biz-b", "alpha@example.com")

        assertEquals(1, addressesBizA.size)
        assertEquals(1, addressesBizB.size)
        assertEquals("Casa A", addressesBizA.first().label)
        assertEquals("Casa B", addressesBizB.first().label)
        assertTrue(addressesBizA.first().isDefault)
        assertTrue(addressesBizB.first().isDefault)
    }
}
