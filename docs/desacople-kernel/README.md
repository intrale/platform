# Desacople kernel operativo ↔ producto (Ola 8)

Serie de documentos de **definición** de la Ola 8: partir el modelo operativo (el pipeline que
orquesta agentes) en un **kernel operativo genérico** y un **adaptador de producto** (la parte
que sabe que el producto es Intrale).

> La Ola 8 **define**; la Ola 9 **implementa**. Estos documentos son vivos y se revisan al
> entrar a implementar. Cero riesgo para Intrale: el `.pipeline/` actual no se toca.

## Índice

| Épica | Documento | Estado |
|-------|-----------|--------|
| EP-OLA8-A · Inventario de frontera | [`inventario-frontera.md`](./inventario-frontera.md) | ✅ Entregado (#4009) |
| EP-OLA8-B · Contrato kernel↔adaptador | [`../pipeline/contrato-kernel-adaptador.md`](../pipeline/contrato-kernel-adaptador.md) | ✅ Entregado (#4010) |
| EP-OLA8-F · Coexistencia (sub-track a) | [`../pipeline/kernel-coexistencia.md`](../pipeline/kernel-coexistencia.md) | ✅ Entregado (#4014) |
| EP-OLA8-F · Actualizaciones del kernel (sub-track b) | [`../pipeline/kernel-updates.md`](../pipeline/kernel-updates.md) | ✅ Entregado (#4014) |

## Cómo encadenan

El **inventario** (EP-OLA8-A) mapea y clasifica qué está pegado al producto y dónde. Su
**lista priorizada de acoplamientos críticos** es el input directo del **contrato**
(EP-OLA8-B), que traza la frontera formal kernel↔adaptador.

La **coexistencia + actualizaciones** (EP-OLA8-F) cierra el círculo: **consume** la frontera
(EP-OLA8-A) y el contrato (EP-OLA8-B) para definir **cómo Intrale pasa del pipeline legacy al kernel
sin downtime** (sub-track a · [`kernel-coexistencia.md`](../pipeline/kernel-coexistencia.md)) y
**cómo se versionan/distribuyen/aplican las updates del propio kernel**, incluida la decisión de
auto-hospedaje vs canal separado (sub-track b ·
[`kernel-updates.md`](../pipeline/kernel-updates.md), acoplado a EP-OLA8-D #4012). Ambos sub-tracks se
mantienen separados a propósito: tienen ritmos de riesgo distintos (coexistencia operativa vs
seguridad de cadena de suministro) y generan **sub-épicas de Ola 9 diferenciadas**.

> **Gate Ola 8:** estos documentos son **definición**. La promoción a implementación (Ola 9) de
> EP-OLA8-F requiere **OK humano** — sin `Ready` automático.
