---
"medsync-back": patch
---

NC2: si falla la bitácora de MySQL, la lectura autorizada de historia clínica (vigente, versión) y del detalle de receta se entrega sólo después de guardar el acceso en un respaldo durable del servidor; si también falla el respaldo, la lectura se bloquea. El respaldo se vacía a la bitácora con el identificador y la hora originales, y Soporte recibe un aviso agrupado por avería que se reintenta si el canal falla. La preparación de salidas de receta sigue bloqueándose.
