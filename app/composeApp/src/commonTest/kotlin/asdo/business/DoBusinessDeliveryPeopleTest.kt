package asdo.business

import ar.com.intrale.shared.business.BusinessDeliveryPersonDTO
import ar.com.intrale.shared.business.DeliveryPersonSummaryDTO
import ar.com.intrale.shared.business.InviteDeliveryPersonResponseDTO
import ar.com.intrale.shared.business.ToggleDeliveryPersonStatusResponseDTO
import ext.business.CommGetBusinessDeliveryPeopleService
import ext.business.CommInviteDeliveryPersonService
import ext.business.CommListBusinessDeliveryPeopleService
import ext.business.CommToggleDeliveryPersonStatusService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// region DoListBusinessDeliveryPeople

class DoListBusinessDeliveryPeopleTest {

    private fun fakeService(result: Result<List<BusinessDeliveryPersonDTO>>) =
        object : CommListBusinessDeliveryPeopleService {
            override suspend fun listDeliveryPeople(businessId: String) = result
        }

    @Test
    fun `lista exitosa retorna repartidores mapeados al dominio`() = runTest {
        val dtos = listOf(
            BusinessDeliveryPersonDTO(email = "a@test.com", fullName = "Ana", status = "ACTIVE"),
            BusinessDeliveryPersonDTO(email = "b@test.com", fullName = "Beto", status = "PENDING")
        )
        val sut = DoListBusinessDeliveryPeople(fakeService(Result.success(dtos)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        val people = result.getOrThrow()
        assertEquals(2, people.size)
        assertEquals("a@test.com", people[0].email)
        assertEquals(BusinessDeliveryPersonStatus.ACTIVE, people[0].status)
        assertEquals(BusinessDeliveryPersonStatus.PENDING, people[1].status)
    }

    @Test
    fun `lista vacia retorna lista vacia`() = runTest {
        val sut = DoListBusinessDeliveryPeople(fakeService(Result.success(emptyList())))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(0, result.getOrThrow().size)
    }

    @Test
    fun `error del servicio retorna failure`() = runTest {
        val sut = DoListBusinessDeliveryPeople(
            fakeService(Result.failure(Exception("timeout")))
        )

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoToggleDeliveryPersonStatus

class DoToggleDeliveryPersonStatusTest {

    private fun fakeService(result: Result<ToggleDeliveryPersonStatusResponseDTO>) =
        object : CommToggleDeliveryPersonStatusService {
            override suspend fun toggleStatus(
                businessId: String,
                email: String,
                newStatus: String
            ) = result
        }

    @Test
    fun `toggle exitoso retorna repartidor con nuevo estado`() = runTest {
        val dto = ToggleDeliveryPersonStatusResponseDTO(email = "a@test.com", newStatus = "INACTIVE")
        val sut = DoToggleDeliveryPersonStatus(fakeService(Result.success(dto)))

        val result = sut.execute("biz-1", "a@test.com", BusinessDeliveryPersonStatus.INACTIVE)

        assertTrue(result.isSuccess)
        assertEquals("a@test.com", result.getOrThrow().email)
        assertEquals(BusinessDeliveryPersonStatus.INACTIVE, result.getOrThrow().status)
    }

    @Test
    fun `error del servicio retorna failure`() = runTest {
        val sut = DoToggleDeliveryPersonStatus(
            fakeService(Result.failure(Exception("forbidden")))
        )

        val result = sut.execute("biz-1", "a@test.com", BusinessDeliveryPersonStatus.ACTIVE)

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoInviteDeliveryPerson

class DoInviteDeliveryPersonTest {

    private fun fakeService(result: Result<InviteDeliveryPersonResponseDTO>) =
        object : CommInviteDeliveryPersonService {
            override suspend fun invite(businessId: String, email: String) = result
        }

    @Test
    fun `invitacion exitosa retorna mensaje`() = runTest {
        val dto = InviteDeliveryPersonResponseDTO(email = "new@test.com", message = "Invitacion enviada")
        val sut = DoInviteDeliveryPerson(fakeService(Result.success(dto)))

        val result = sut.execute("biz-1", "new@test.com")

        assertTrue(result.isSuccess)
        assertEquals("Invitacion enviada", result.getOrThrow())
    }

    @Test
    fun `error del servicio retorna failure`() = runTest {
        val sut = DoInviteDeliveryPerson(
            fakeService(Result.failure(Exception("conflict")))
        )

        val result = sut.execute("biz-1", "dup@test.com")

        assertTrue(result.isFailure)
    }
}

// endregion

// region DoGetBusinessDeliveryPeople (pre-existente, para completar cobertura)

class DoGetBusinessDeliveryPeopleTest {

    private fun fakeService(result: Result<List<DeliveryPersonSummaryDTO>>) =
        object : CommGetBusinessDeliveryPeopleService {
            override suspend fun listDeliveryPeople(businessId: String) = result
        }

    @Test
    fun `lista exitosa retorna repartidores mapeados al dominio`() = runTest {
        val dtos = listOf(
            DeliveryPersonSummaryDTO(email = "a@test.com", fullName = "Ana"),
            DeliveryPersonSummaryDTO(email = "b@test.com", fullName = "Beto")
        )
        val sut = DoGetBusinessDeliveryPeople(fakeService(Result.success(dtos)))

        val result = sut.execute("biz-1")

        assertTrue(result.isSuccess)
        assertEquals(2, result.getOrThrow().size)
        assertEquals("a@test.com", result.getOrThrow()[0].email)
        assertEquals("Ana", result.getOrThrow()[0].fullName)
    }

    @Test
    fun `error del servicio retorna failure`() = runTest {
        val sut = DoGetBusinessDeliveryPeople(
            fakeService(Result.failure(Exception("network error")))
        )

        val result = sut.execute("biz-1")

        assertTrue(result.isFailure)
    }
}

// endregion
