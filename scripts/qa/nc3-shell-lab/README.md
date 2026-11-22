# Laboratorio de shell completo NC3/C22 (solo máquina local, datos sintéticos)

Levanta MedSync completo y aislado: MySQL 8.4 en Docker (puerto 33950), testigo externo (4350), backend real (3009) y frontend real (4324).
Nada de esto toca Alameda test ni producción. Las credenciales son sintéticas y de laboratorio.

Orden de preparación (ver `scripts/qa/nc3-shell-lab/prepare.sh`): el esquema exportado del workspace va por detrás de las migraciones, así que se
cargan las 86 tablas, funciones, procedimientos y vistas, el definidor `marcos`, las migraciones aplicables con sus indicadores
explícitos, columnas de login que faltan en el export y las semillas (catálogos de permisos, consultorio, Valeria con rol doctor, Sofía con
rol recepción solo de Agenda y un paciente sintético).

Inicio de sesión (rutas de la interfaz): `http://localhost:4324/login`. Usuarios: `valeria@lab.example.test` (doctor) y `sofia@lab.example.test`
(recepción). Contraseña de laboratorio en `F:\HemiaAssistantGlobal\_qa\nc3-shell-lab\lab.env` (no se versiona). Una nueva sesión de un mismo usuario cierra la anterior.

Paciente: `http://localhost:4324/px/history/lab_pat1?tab=monitoring`.
