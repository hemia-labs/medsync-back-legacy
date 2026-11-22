// NC3/C22 (SOLO QA): proceso de entrega independiente para ensayar su caída y reinicio. En operación el despachador es el del backend;
// no se ejecuta junto a él (el bloqueo del despachador lo impide). NC3/C22: proceso de entrega independiente. Ejecuta el despachador de referencias al testigo y el conciliador con incidentes
// para Soporte, sin servir HTTP. Sirve para correr la entrega como proceso propio y para ensayar su caída y reinicio reales:
// el estado vive en MySQL (cola de referencias) y en el archivo de incidentes, no en este proceso.
//   node scripts/qa/nc3-delivery-worker.js     (usa las mismas variables EVOLUTION_INTEGRITY_* y DB_* que el backend)
'use strict';
const db = require('../../src/db/Sequelize.connection');
const witness = require('../../src/services/evolutionIntegrityWitness.service');
const { createReconciler, install } = require('../../src/services/evolutionIntegrityReconciler');

const cfg = witness.config();
if (!cfg.enabled) { console.error('NC3_WORKER_DISABLED'); process.exit(2); }
const reconciler = install(createReconciler({ db, witnessCfg: cfg }));
if (!reconciler.start(Number(process.env.EVOLUTION_INTEGRITY_RECONCILE_MS) || 300000, { retryMs: Number(process.env.EVOLUTION_INTEGRITY_RETRY_MS) || 5000 })) { console.error('NC3_WORKER_NOT_STARTED: ya hay un despachador activo'); process.exit(3); }
console.log('NC3_WORKER_READY pid=' + process.pid);
const stop = async () => { reconciler.stop(); await db.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
