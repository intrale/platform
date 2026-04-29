package ui.sc.business.delivery

import asdo.business.delivery.Coordinate
import asdo.business.delivery.DeliveryZone
import asdo.business.delivery.DeliveryZoneDraft
import asdo.business.delivery.DoSaveDeliveryZoneException
import asdo.business.delivery.MAX_ZONE_COST_CENTS
import asdo.business.delivery.ToDoSaveDeliveryZone
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.coroutines.CoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests del DeliveryZonesViewModel — cubre los 10 casos mínimos exigidos por CA-20 (#2447).
 *
 * Usamos un dispatcher unconfined "manual" que ejecuta inmediato, para no depender
 * de StandardTestDispatcher (no resuelto en KMP+Compose 1.10.2 según nuestra config).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeliveryZonesViewModelTest {

    private val baseDraftCenter = Coordinate(-34.6, -58.4)

    /**
     * Dispatcher inmediato: corre las corrutinas en el mismo hilo del test.
     * Suficiente para verificar invocaciones, debounce con tryLock y cleanup en logout.
     */
    private class ImmediateDispatcher : CoroutineDispatcher() {
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            block.run()
        }
    }

    /** Fake controlable: registra invocaciones y permite resolver/fallar a demanda. */
    private class FakeToDoSaveDeliveryZone : ToDoSaveDeliveryZone {
        var invocationCount: Int = 0
            private set
        var nextResult: Result<DeliveryZone>? = null
        var deferred: CompletableDeferred<Result<DeliveryZone>>? = null
        val recordedDrafts: MutableList<DeliveryZoneDraft> = mutableListOf()

        override suspend fun execute(draft: DeliveryZoneDraft): Result<DeliveryZone> {
            invocationCount += 1
            recordedDrafts += draft
            deferred?.let { return it.await() }
            return nextResult ?: Result.success(
                DeliveryZone(
                    id = "zone-${invocationCount}",
                    businessId = draft.businessId,
                    name = draft.name,
                    center = draft.center,
                    radiusMeters = draft.radiusMeters,
                    costCents = draft.costCents,
                    estimatedMinutes = draft.estimatedMinutes,
                )
            )
        }
    }

    private fun newVm(
        fake: ToDoSaveDeliveryZone = FakeToDoSaveDeliveryZone(),
        businessId: String? = "biz-1",
        scope: CoroutineScope,
    ): DeliveryZonesViewModel = DeliveryZonesViewModel(
        toDoSaveDeliveryZone = fake,
        businessId = businessId,
        dispatcher = ImmediateDispatcher(),
        externalScope = scope,
    )

    private fun fillValidEditor(vm: DeliveryZonesViewModel) {
        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1500)
        vm.openSheet()
        vm.onNameChange("Centro CABA")
        vm.onCostChange("250000")
        vm.onEstimatedMinutesChange(45)
    }

    @Test
    fun `save con parametros validos invoca DoSaveDeliveryZone una vez`() = runTest {
        val fake = FakeToDoSaveDeliveryZone()
        val vm = newVm(fake, scope = this)

        fillValidEditor(vm)
        vm.saveZone()
        advanceUntilIdle()

        assertEquals(1, fake.invocationCount)
        assertEquals(1, vm.state.zones.size)
        assertNull(vm.state.editor)
        val draft = fake.recordedDrafts.single()
        assertEquals("biz-1", draft.businessId)
        assertEquals("Centro CABA", draft.name)
        assertEquals(1500, draft.radiusMeters)
        assertEquals(250_000L, draft.costCents)
        assertEquals(45, draft.estimatedMinutes)
    }

    @Test
    fun `save con error mapea a estado de error visible en UI`() = runTest {
        val fake = FakeToDoSaveDeliveryZone().apply {
            nextResult = Result.failure(DoSaveDeliveryZoneException.Generic("Network error"))
        }
        val vm = newVm(fake, scope = this)

        fillValidEditor(vm)
        vm.saveZone()
        advanceUntilIdle()

        assertEquals(1, fake.invocationCount)
        assertNotNull(vm.state.editor)
        assertEquals("Network error", vm.state.editor?.saveError)
        assertFalse(vm.state.editor!!.isSaving)
        assertEquals(0, vm.state.zones.size)
    }

    @Test
    fun `rotacion preserva centro radio y flag sheetVisible`() = runTest {
        val vm = newVm(scope = this)

        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(2300)
        vm.openSheet()
        vm.onNameChange("Zona A")
        vm.onEstimatedMinutesChange(30)

        // Simulamos "rotación" leyendo el estado y verificando que se mantiene
        // tras una recomposición lógica (el ViewModel sobrevive por lifecycle).
        val snapshot = vm.state.editor
        assertNotNull(snapshot)
        assertEquals(baseDraftCenter, snapshot.center)
        assertEquals(2300, snapshot.radiusMeters)
        assertTrue(snapshot.sheetVisible)
        assertEquals("Zona A", snapshot.nameInput)
        assertEquals(30, snapshot.estimatedMinutes)
    }

    @Test
    fun `tope de 10 zonas deja FAB disabled`() = runTest {
        val vm = newVm(scope = this)

        val tenZones = (1..10).map { i ->
            DeliveryZone(
                id = "z-$i",
                businessId = "biz-1",
                name = "Zona $i",
                center = baseDraftCenter,
                radiusMeters = 1000,
                costCents = 100_000L,
                estimatedMinutes = 30,
            )
        }
        vm.setZones(tenZones)

        assertTrue(vm.state.isAtLimit)
        assertFalse(vm.state.canCreateMore)

        vm.openEditor()
        // No debe abrir el editor al estar en tope.
        assertNull(vm.state.editor)
    }

    @Test
    fun `doble click rapido produce un solo POST (debounce)`() = runTest {
        val fake = FakeToDoSaveDeliveryZone().apply {
            deferred = CompletableDeferred()
        }
        val vm = newVm(fake, scope = this)

        fillValidEditor(vm)
        vm.saveZone()
        vm.saveZone()
        vm.saveZone()
        advanceTimeBy(50)

        // Sólo debió capturar una invocación porque el mutex ya está tomado.
        assertEquals(1, fake.invocationCount)

        // Resolvemos para limpiar el job.
        fake.deferred?.complete(Result.success(
            DeliveryZone(
                id = "zone-1",
                businessId = "biz-1",
                name = "Centro CABA",
                center = baseDraftCenter,
                radiusMeters = 1500,
                costCents = 250_000L,
                estimatedMinutes = 45,
            )
        ))
        advanceUntilIdle()
        assertEquals(1, fake.invocationCount)
    }

    @Test
    fun `save con nombre con caracteres invalidos es rechazado antes de llamar al servicio`() = runTest {
        val fake = FakeToDoSaveDeliveryZone()
        val vm = newVm(fake, scope = this)

        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1000)
        vm.openSheet()
        vm.onNameChange("<script>alert(1)</script>")
        vm.onCostChange("100000")
        vm.onEstimatedMinutesChange(30)

        vm.saveZone()
        advanceUntilIdle()

        assertEquals(0, fake.invocationCount)
        assertEquals("Nombre invalido", vm.state.editor?.nameError)
        assertFalse(vm.state.editor!!.canSave)
    }

    @Test
    fun `costo negativo nunca llega como negativo al servicio`() = runTest {
        val fake = FakeToDoSaveDeliveryZone()
        val vm = newVm(fake, scope = this)

        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1000)
        vm.openSheet()
        vm.onNameChange("Zona OK")
        vm.onCostChange("-500")
        vm.onEstimatedMinutesChange(30)

        // El input se filtra a sólo dígitos, así que un signo "-" no entra.
        assertEquals("500", vm.state.editor?.costCentsInput)
        assertNull(vm.state.editor?.costError)

        vm.saveZone()
        advanceUntilIdle()

        // Lo crítico es que jamás se envía un costo negativo.
        assertTrue(fake.recordedDrafts.all { it.costCents >= 0 })
    }

    @Test
    fun `save con costo mayor al maximo es rechazado`() = runTest {
        val fake = FakeToDoSaveDeliveryZone()
        val vm = newVm(fake, scope = this)

        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1000)
        vm.openSheet()
        vm.onNameChange("Zona OK")
        // 1.000.000.001 cents > MAX
        vm.onCostChange((MAX_ZONE_COST_CENTS + 1L).toString())
        vm.onEstimatedMinutesChange(30)

        assertEquals("Costo supera el maximo", vm.state.editor?.costError)

        vm.saveZone()
        advanceUntilIdle()

        assertEquals(0, fake.invocationCount)
    }

    @Test
    fun `cancel de saveZone al cerrar editor por logout no completa el POST`() = runTest {
        val fake = FakeToDoSaveDeliveryZone().apply {
            // Bloqueamos la respuesta para tener una save in-flight.
            deferred = CompletableDeferred()
        }
        val vm = newVm(fake, scope = this)

        fillValidEditor(vm)
        vm.saveZone()
        advanceTimeBy(10)
        // Hay una save in-flight pero no resuelta aún.
        assertEquals(1, fake.invocationCount)

        vm.onLogout()
        advanceUntilIdle()

        // Aunque el deferred siga pendiente, el VM debe haber limpiado estado y
        // cancelado la coroutine. La invocación al fake ya ocurrió pero el éxito
        // no se persiste (no se agrega zona).
        assertEquals(0, vm.state.zones.size)
        assertNull(vm.state.editor)
    }

    @Test
    fun `estado del editor se limpia al recibir evento de logout`() = runTest {
        val vm = newVm(scope = this)

        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1500)
        vm.openSheet()
        vm.onNameChange("Datos parciales")

        assertNotNull(vm.state.editor)

        vm.onLogout()

        assertNull(vm.state.editor)
        assertEquals(emptyList(), vm.state.zones)
    }

    @Test
    fun `tope client side bloquea saveZone aunque el editor este abierto`() = runTest {
        val fake = FakeToDoSaveDeliveryZone()
        val vm = newVm(fake, scope = this)

        // Abrimos editor antes de llenar lista.
        vm.openEditor()
        vm.onMapTap(baseDraftCenter)
        vm.onRadiusChange(1000)
        vm.openSheet()
        vm.onNameChange("Zona Once")
        vm.onCostChange("100000")
        vm.onEstimatedMinutesChange(30)

        // Forzamos el tope de 10 a posteriori (race con otro device).
        val tenZones = (1..10).map { i ->
            DeliveryZone(
                id = "z-$i",
                businessId = "biz-1",
                name = "Zona $i",
                center = baseDraftCenter,
                radiusMeters = 1000,
                costCents = 100_000L,
                estimatedMinutes = 30,
            )
        }
        vm.setZones(tenZones)

        vm.saveZone()
        advanceUntilIdle()

        assertEquals(0, fake.invocationCount)
        assertEquals("Limite de 10 zonas alcanzado", vm.state.editor?.saveError)
    }
}

@Suppress("unused")
private fun isolatedScope(): CoroutineScope = CoroutineScope(SupervisorJob())
