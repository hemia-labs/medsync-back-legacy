'use strict';
const config=require('../config/config');
const D=require('../domain/odontogram/operations');
const fields=['modality','dentition','operations','corrections','errors','active_seconds','paused_seconds'];
function validate(body) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!fields.includes(key)))D.fail('Las métricas solo admiten contadores agregados.');
    if(!['keyboard','touch','mouse','hybrid','idle'].includes(body.modality)||!['permanent','primary','mixed'].includes(body.dentition))D.fail('Modalidad o dentición de métricas inválida.');
    for(const field of fields.slice(2))if(!Number.isSafeInteger(body[field])||body[field]<0||body[field]>2678400)D.fail('Contador agregado inválido.');
    return Object.fromEntries(fields.map(field=>[field,body[field]]));
}
function enabled(settings=config) {
    try{const url=new URL(settings.CO26_UMAMI_URL);return Boolean(settings.CO26_METRICS_ENABLED&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&/^[a-f0-9-]{36}$/i.test(settings.CO26_UMAMI_WEBSITE_ID)&&/^[a-z0-9.-]{1,253}$/i.test(settings.CO26_UMAMI_HOSTNAME));}catch(error){return false;}
}
async function send(body,post=fetch,settings=config) {
    const data=validate(body);
    if(!enabled(settings))return{enabled:false,accepted:false};
    // Fixed route/title/referrer. Never forward req headers, browser URL, IDs,
    // commands, notes or clinical objects. Umami API: docs.umami.is/docs/api/sending-stats
    const payload={type:'event',payload:{website:settings.CO26_UMAMI_WEBSITE_ID,hostname:settings.CO26_UMAMI_HOSTNAME,
        language:'es-MX',url:'/clinical/odontogram',referrer:'',title:'Odontograma',name:'co26_usage',data}};
    try{const response=await post(settings.CO26_UMAMI_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(2000),headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 (compatible; MedSyncCO26/1.0)'},body:JSON.stringify(payload)});return{enabled:true,accepted:Boolean(response.ok)};}
    catch(error){return{enabled:true,accepted:false};}
}
module.exports={validate,enabled,send};
