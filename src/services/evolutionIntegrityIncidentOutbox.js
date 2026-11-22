'use strict';
// NC3/C22 R2: cola durable de incidentes para Soporte. Vive en un archivo del servidor, fuera de MySQL, para que una restauración
// de la base no borre un incidente que esa misma restauración provocó. Guarda identificadores, códigos, números de secuencia e
// intentos (hora y resultado); nunca texto clínico. Cada CICLO de un incidente es una entrada propia (id + ciclo): reabrir el mismo
// incidente no sobrescribe un ciclo anterior que aún espera su entrega.
// Un solo despachador activo: el bloqueo (archivo .lock con el pid) impide dos procesos escribiendo y entregando a la vez.
const fs = require('node:fs');
const path = require('node:path');

const keyOf = entry => entry.id + '#' + (entry.cycle || 1);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

function createOutbox(file) {
    const entries = new Map();
    try { for (const e of JSON.parse(fs.readFileSync(file, 'utf8'))) entries.set(keyOf(e), e); } catch (error) { if (error.code !== 'ENOENT') console.error('NC3_INCIDENT_OUTBOX_UNREADABLE', error.message); }
    const lockFile = file + '.lock';
    let held = false;
    function save() {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = file + '.tmp', fd = fs.openSync(temp, 'w', 0o600);
        try { fs.writeSync(fd, JSON.stringify([...entries.values()], null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
    }
    return {
        // Ciclo vigente (el más reciente) de un incidente lógico.
        latest: id => [...entries.values()].filter(e => e.id === id).sort((a, b) => b.cycle - a.cycle)[0],
        get: key => entries.get(key),
        all: () => [...entries.values()],
        put(entry) { entries.set(keyOf(entry), entry); save(); return entry; },
        save, file, keyOf,
        // Devuelve false si otro proceso vivo ya es el despachador. El mismo proceso puede volver a adquirirlo.
        acquire() {
            if (held) return true;
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            for (let i = 0; i < 2; i++) {
                try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); held = true; return true; }
                catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
                    if (pid === process.pid) { held = true; return true; }
                    if (alive(pid)) return false;
                    try { fs.unlinkSync(lockFile); } catch { /* otro proceso lo tomó */ }
                }
            }
            return false;
        },
        release() { if (held) { held = false; try { fs.unlinkSync(lockFile); } catch { /* ya no existe */ } } }
    };
}

module.exports = { createOutbox };
