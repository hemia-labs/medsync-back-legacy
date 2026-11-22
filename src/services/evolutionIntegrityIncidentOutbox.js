'use strict';
// NC3/C22 R2: cola durable de incidentes para Soporte. Vive en un archivo del servidor de la aplicación, fuera de MySQL,
// para que una restauración de la base no borre un incidente que esa misma restauración provocó. Guarda identificadores,
// códigos, números de secuencia e intentos (con hora y resultado); nunca texto clínico. Un solo proceso escribe.
const fs = require('node:fs');
const path = require('node:path');

function createOutbox(file) {
    let entries = new Map();
    try { for (const e of JSON.parse(fs.readFileSync(file, 'utf8'))) entries.set(e.id, e); } catch (error) { if (error.code !== 'ENOENT') console.error('NC3_INCIDENT_OUTBOX_UNREADABLE', error.message); }
    function save() {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = file + '.tmp', fd = fs.openSync(temp, 'w', 0o600);
        try { fs.writeSync(fd, JSON.stringify([...entries.values()], null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
    }
    return {
        get: id => entries.get(id),
        all: () => [...entries.values()],
        put(entry) { entries.set(entry.id, entry); save(); return entry; },
        save,
        file
    };
}

module.exports = { createOutbox };
