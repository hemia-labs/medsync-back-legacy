---
"medsync-back": patch
---

NC2: el vaciado del respaldo de lecturas clínicas retira la evidencia de un acceso sólo cuando el aviso de su avería está completo en disco o ya tiene acuse del receptor. Los avisos se guardan escribiendo todos los bytes, y una entrada que no pudo guardarse queda en memoria para reintentarse.
