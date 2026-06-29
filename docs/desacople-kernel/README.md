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

## Cómo encadenan

El **inventario** (EP-OLA8-A) mapea y clasifica qué está pegado al producto y dónde. Su
**lista priorizada de acoplamientos críticos** es el input directo del **contrato**
(EP-OLA8-B), que traza la frontera formal kernel↔adaptador.
