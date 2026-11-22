// NC3/C22: consulta y cierre de incidentes de integridad por Soporte de HEMIA.
//   node scripts/ops/nc3-incident.js list
//   node scripts/ops/nc3-incident.js close <INC-id> --by "<quien>" --evidence "<referencia de la verificación, sin texto clínico>"
// Requiere EVOLUTION_INTEGRITY_WITNESS_URL / _ENV / _SUPPORT_TOKEN. El cierre solo agrega un evento: la traza queda completa.
'use strict';
const witness = require('../../src/services/evolutionIntegrityWitness.service');

async function run(argv, env = process.env, out = console.log) {
    const cfg = witness.config(env);
    if (!cfg.enabled || !cfg.supportToken) throw Error('Configura el testigo y el token de Soporte.');
    const [cmd, id] = argv;
    const flag = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };
    const events = (await witness.incidents(cfg)).data.events;
    if (cmd === 'list') {
        const byId = new Map();
        for (const e of events) { const cur = byId.get(e.id) || { id: e.id, events: [] }; cur.events.push(e.type + '@' + e.receivedAt); if (e.code) cur.code = e.code; if (e.business) { cur.business = e.business; cur.patient = e.patient; } cur.state = ['open', 'cleared', 'closed'].includes(e.type) ? e.type : cur.state; byId.set(e.id, cur); }
        out(JSON.stringify([...byId.values()], null, 2));
        return;
    }
    if (cmd === 'close') {
        const open = events.filter(e => e.id === id);
        if (!open.length) throw Error('Incidente desconocido.');
        const last = [...open].reverse().find(e => ['open', 'cleared', 'closed'].includes(e.type));
        if (last.type === 'open') throw Error('La condición sigue activa: el conciliador debe registrar que se resolvió antes del cierre.');
        if (!flag('by') || !flag('evidence')) throw Error('Indica --by y --evidence.');
        const done = await witness.postIncident(cfg, { id, type: 'closed', code: open[0].code, business: open[0].business, patient: open[0].patient, by: flag('by'), evidence: flag('evidence') });
        out(JSON.stringify(done.data));
        return;
    }
    throw Error('Uso: list | close <id> --by <quien> --evidence <referencia>');
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
