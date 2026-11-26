---
"medsync-back": patch
---

NC2: el ciclo de aviso de una avería se guarda, y su resolución también, antes de retirar la última evidencia del acceso, aunque Soporte ya haya acusado. El archivo de avisos se relee antes de consultar, despachar o guardar: un volumen que no respondía al arrancar se recupera sin otro reinicio y sin sustituir su contenido.
