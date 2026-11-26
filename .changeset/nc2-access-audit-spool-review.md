---
"medsync-back": patch
---

NC2: correcciones de la revisión cruzada del respaldo de lecturas clínicas:

- El aviso a Soporte usa la referencia `INC-` del receptor de C22.
- El vaciado persiste el aviso de la avería antes de retirar la evidencia de un acceso.
- La lectura interna de historia sigue a su transacción, y el contenido se prepara antes de registrar el acceso.
- Un respaldo inutilizable ya no impide arrancar la API: se comunica y se reintenta.
- Una escritura parcial se completa antes de publicarse. Si no puede completarse, la lectura se bloquea.
