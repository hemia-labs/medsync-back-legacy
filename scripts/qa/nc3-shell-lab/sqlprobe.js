// Solo laboratorio: registra el error SQL real que el backend enmascara (sin parámetros ni datos).
const Module=require('module');const orig=Module.prototype.require;
Module.prototype.require=function(id){const m=orig.apply(this,arguments);
 if(/db[\/]Sequelize\.connection$/.test(id)&&m&&m.query&&!m.__probed){m.__probed=true;const q=m.query.bind(m);m.query=async function(...a){try{return await q(...a)}catch(e){console.error('SQLERR',String(e.message).slice(0,160),'|',String(a[0]).replace(/\s+/g,' ').slice(0,80));throw e}}}
 return m};
