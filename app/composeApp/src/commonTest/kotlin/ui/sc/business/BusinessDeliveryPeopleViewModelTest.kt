package ui.sc.business

import asdo.business.BusinessDeliveryPerson
import asdo.business.BusinessDeliveryPersonStatus
import asdo.business.ToDoInviteDeliveryPerson
import asdo.business.ToDoListBusinessDeliveryPeople
import asdo.business.ToDoToggleDeliveryPersonStatus
import kotlinx.coroutines.test.runTest
import org.kodein.log.LoggerFactory
import org.kodein.log.frontend.simplePrintFrontend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeListDeliveryPeople(
    private val result: Result<List<BusinessDeliveryPerson>>
) : ToDoListBusinessDeliveryPeople {
    override suspend fun execute(businessId: String): Result<List<BusinessDeliveryPerson>> = result
}

private class FakeToggleStatus(
    private val result: Result<BusinessDeliveryPerson>
) : ToDoToggleDeliveryPersonStatus {
    override suspend fun execute(
        businessId: String,
        email: String,
        newStatus: BusinessDeliveryPersonStatus
    ): Result<BusinessDeliveryPerson> = result
}

private class FakeInvitePerson(
    private val result: Result<String>
) : ToDoInviteDeliveryPerson {
    override suspend fun execute(businessId: String, email: String): Result<String> = result
}

private val testLoggerFactory = LoggerFactory(listOf(simplePrintFrontend))

private val samplePeople = listOf(
    BusinessDeliveryPerson(email = "a@test.com", fullName = "Ana", status = BusinessDeliveryPersonStatus.ACTIVE),
    BusinessDeliveryPerson(email = "b@test.com", fullName = "Beto", status = BusinessDeliveryPersonStatus.PENDING)
)

class BusinessDeliveryPeopleViewModelTest {

    @Test
    fun `estado missing cuando no hay negocio seleccionado`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load(null)
        assertEquals(BusinessDeliveryPeopleStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `estado missing cuando businessId es blank`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("")
        assertEquals(BusinessDeliveryPeopleStatus.MissingBusiness, vm.state.status)
    }

    @Test
    fun `carga exitosa con repartidores popula la lista`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        assertEquals(BusinessDeliveryPeopleStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.people.size)
    }

    @Test
    fun `carga exitosa sin repartidores muestra estado vacio`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        assertEquals(BusinessDeliveryPeopleStatus.Empty, vm.state.status)
    }

    @Test
    fun `error al cargar cambia estado a Error`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.failure(Exception("fallo red"))),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        assertEquals(BusinessDeliveryPeopleStatus.Error, vm.state.status)
        assertTrue(vm.state.errorMessage?.isNotBlank() == true)
    }

    @Test
    fun `toggle cambia estado del repartidor en la lista`() = runTest {
        val toggled = samplePeople[0].copy(status = BusinessDeliveryPersonStatus.INACTIVE)
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(toggled)),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        val result = vm.toggle("a@test.com", BusinessDeliveryPersonStatus.ACTIVE)
        assertTrue(result.isSuccess)
        assertEquals(
            BusinessDeliveryPersonStatus.INACTIVE,
            vm.state.people.first { it.email == "a@test.com" }.status
        )
        assertNull(vm.state.togglingEmail)
    }

    @Test
    fun `toggle falla cuando no hay negocio seleccionado`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        val result = vm.toggle("a@test.com", BusinessDeliveryPersonStatus.ACTIVE)
        assertTrue(result.isFailure)
    }

    @Test
    fun `toggle error del servicio actualiza errorMessage`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.failure(Exception("toggle error"))),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        val result = vm.toggle("a@test.com", BusinessDeliveryPersonStatus.ACTIVE)
        assertTrue(result.isFailure)
        assertEquals("toggle error", vm.state.errorMessage)
    }

    @Test
    fun `showInviteDialog abre el dialogo con campos limpios`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.showInviteDialog()
        assertTrue(vm.state.showInviteDialog)
        assertEquals("", vm.state.inviteEmail)
        assertNull(vm.state.inviteError)
    }

    @Test
    fun `dismissInviteDialog cierra el dialogo`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.showInviteDialog()
        vm.dismissInviteDialog()
        assertFalse(vm.state.showInviteDialog)
    }

    @Test
    fun `updateInviteEmail actualiza el email y limpia error`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.updateInviteEmail("nuevo@test.com")
        assertEquals("nuevo@test.com", vm.state.inviteEmail)
        assertNull(vm.state.inviteError)
    }

    @Test
    fun `invite exitosa cierra dialogo y recarga lista`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("Invitacion enviada")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        vm.showInviteDialog()
        vm.updateInviteEmail("new@test.com")
        val result = vm.invite()
        assertTrue(result.isSuccess)
        assertFalse(vm.state.showInviteDialog)
    }

    @Test
    fun `invite con email vacio falla con error`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        vm.showInviteDialog()
        val result = vm.invite()
        assertTrue(result.isFailure)
        assertTrue(vm.state.inviteError?.isNotBlank() == true)
    }

    @Test
    fun `invite falla cuando no hay negocio seleccionado`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(emptyList())),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.showInviteDialog()
        vm.updateInviteEmail("new@test.com")
        val result = vm.invite()
        assertTrue(result.isFailure)
    }

    @Test
    fun `invite error del servicio muestra error en dialogo`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.failure(Exception("email duplicado"))),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        vm.showInviteDialog()
        vm.updateInviteEmail("dup@test.com")
        val result = vm.invite()
        assertTrue(result.isFailure)
        assertEquals("email duplicado", vm.state.inviteError)
    }

    @Test
    fun `clearError limpia mensaje de error`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.failure(Exception("error"))),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        assertTrue(vm.state.errorMessage?.isNotBlank() == true)
        vm.clearError()
        assertNull(vm.state.errorMessage)
    }

    @Test
    fun `refresh recarga con el mismo businessId`() = runTest {
        val vm = BusinessDeliveryPeopleViewModel(
            listDeliveryPeople = FakeListDeliveryPeople(Result.success(samplePeople)),
            toggleStatus = FakeToggleStatus(Result.success(samplePeople[0])),
            invitePerson = FakeInvitePerson(Result.success("ok")),
            loggerFactory = testLoggerFactory
        )
        vm.load("biz-1")
        assertEquals(BusinessDeliveryPeopleStatus.Loaded, vm.state.status)
        vm.refresh()
        assertEquals(BusinessDeliveryPeopleStatus.Loaded, vm.state.status)
        assertEquals(2, vm.state.people.size)
    }
}
