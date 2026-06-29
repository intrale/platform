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
| EP-OLA8-B · Contrato kernel↔adaptador | _pendiente_ | ⏳ Consume la lista priorizada del inventario |
| EP-OLA8-E · Wizard de setup inicial | [`wizard-setup.md`](./wizard-setup.md) | ✅ Entregado (#4013) — documento vivo, revisa al firmar B/C |

## Cómo encadenan

El **inventario** (EP-OLA8-A) mapea y clasifica qué está pegado al producto y dónde. Su
**lista priorizada de acoplamientos críticos** es el input directo del **contrato**
(EP-OLA8-B), que traza la frontera formal kernel↔adaptador.

El **wizard** (EP-OLA8-E) cierra el círculo: es el **generador del adaptador**. Consume **B**
(contrato) como su esquema de salida — el adaptador que produce valida contra el contrato, si
no, no carga — y **C** (capabilities/plugins) como su **catálogo curado**, de donde el operador
elige el stack y las capabilities. Es la pieza visible del desacople (kernel pelado → wizard →
instancia configurada), pero no la difícil: lo difícil son las capabilities de C. Por eso la
spec del wizard es un **documento vivo** que se revisa al firmar B y C.
