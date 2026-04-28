package ui.sc.client

import asdo.client.DoListBusinessZonesException
import asdo.client.DoListBusinessZonesResult
import asdo.client.SanitizedBoundingBox
import asdo.client.SanitizedBusinessZone
import asdo.client.ToDoListBusinessZones
import asdo.client.ZoneShape
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests del ViewModel del mapa de zonas (issue #2423).
 *
 * Cubre los CA-10 obligatorios:
 * - ZonesMapViewModel refleja carga y luego lista de zonas
 * - ZonesMapViewModel refleja error de red y habilita reintento
 * - ZonesMapViewModel refleja estado vacio cuando zones es lista vacia
 */
class ZonesMapViewModelTest {

    private fun fakeUseCase(result: () -> Result<DoListBusinessZonesResult>): ToDoListBusinessZones =
        object : ToDoListBusinessZones {
            override suspend fun execute(businessId: String): Result<DoListBusinessZonesResult> = result()
        }

    private fun sampleZones(): List<SanitizedBusinessZone> = listOf(
        SanitizedBusinessZone(
            zoneId = "z1",
            name = "Zona Centro",
            type = ZoneShape.POLYGON,
            shippingCost = 300.0,
            currency = "ARS",
        ),
    )

    @Test
    fun `ZonesMapViewModel refleja carga y luego lista de zonas`() = runTest {
        val zones = sampleZones()
        val box = SanitizedBoundingBox(-34.6, -34.5, -58.5, -58.4)
        val use = fakeUseCase {
            Result.success(DoListBusinessZonesResult(zones = zones, boundingBox = box))
        }
        val vm = ZonesMapViewModel(listZones = use)

        vm.loadZones("intrale")

        assertEquals(ZonesMapPhase.Loaded, vm.state.phase)
        assertEquals(1, vm.state.zones.size)
        assertNotNull(vm.state.boundingBox)
        assertEquals("Zona Centro", vm.state.zones.first().name)
    }

    @Test
    fun `ZonesMapViewModel refleja error de red y habilita reintento`() = runTest {
        val use = fakeUseCase {
            Result.failure(DoListBusinessZonesException("Sin red"))
        }
        val vm = ZonesMapViewModel(listZones = use)

        vm.loadZones("intrale")

        assertEquals(ZonesMapPhase.Error, vm.state.phase)
        assertEquals("Sin red", vm.state.errorMessage)
    }

    @Test
    fun `ZonesMapViewModel refleja estado vacio cuando zones es lista vacia`() = runTest {
        val use = fakeUseCase {
            Result.success(DoListBusinessZonesResult(zones = emptyList(), boundingBox = null))
        }
        val vm = ZonesMapViewModel(listZones = use)

        vm.loadZones("intrale")

        assertEquals(ZonesMapPhase.Empty, vm.state.phase)
        assertTrue(vm.state.zones.isEmpty())
    }

    @Test
    fun `ZonesMapViewModel toggleListExpanded alterna el flag`() = runTest {
        val use = fakeUseCase {
            Result.success(DoListBusinessZonesResult(zones = sampleZones(), boundingBox = null))
        }
        val vm = ZonesMapViewModel(listZones = use)
        vm.loadZones("intrale")

        assertTrue(!vm.state.showsListExpanded, "default colapsado")
        vm.toggleListExpanded()
        assertTrue(vm.state.showsListExpanded, "tras toggle expandido")
        vm.toggleListExpanded()
        assertTrue(!vm.state.showsListExpanded, "tras segundo toggle colapsado")
    }

    @Test
    fun `ZonesMapViewModel forceListView lleva el flag a true`() = runTest {
        val use = fakeUseCase {
            Result.failure(DoListBusinessZonesException("Sin red"))
        }
        val vm = ZonesMapViewModel(listZones = use)
        vm.loadZones("intrale")
        assertEquals(ZonesMapPhase.Error, vm.state.phase)

        vm.forceListView()

        assertTrue(vm.state.showsListExpanded)
    }
}
