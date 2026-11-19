'use strict';
const { readZip } = require('./xlsxReader');
const { buildRelease, sha256 } = require('./release');
const { getFamily } = require('./families');
const fail = message => { throw Object.assign(new Error(message), {code:'CATALOG_SOURCE_INVALID'}); };
// Read only the contractual prefix. INEGI's later coordinate columns contain unescaped quotation marks.
function csvPrefix(line, count) {
    const out=[]; let at=0;
    while(out.length<count) {
        let value='';
        if(line[at]==='"') {
            at++; let closed=false;
            while(at<line.length) { const ch=line[at++]; if(ch==='"') {if(line[at]==='"'){value+='"';at++;}else{closed=true;break;}}else value+=ch; }
            if(!closed)fail('CSV: comillas sin cerrar');
        } else {while(at<line.length&&line[at]!==',')value+=line[at++];}
        out.push(value);
        if(out.length<count&&line[at]!==',')fail('CSV: columna incompleta');
        at++;
    }
    return out;
}
function importGeographicZip(buffer, {family, member, downloadedAt, releaseId, sourceUrl, sourceVersion=null}) {
    const postal=family==='sepomex.postal_code', lengths={'inegi.state':2,'inegi.municipality':5,'inegi.locality':9};
    if(!postal&&!lengths[family])fail('Familia no soportada');
    const encoding=postal?'windows-1252':'utf-8';
    const text=readZip(buffer,member).read(member,encoding);
    if(!text)fail('Miembro no encontrado');
    const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean), entries=[];
    let mapping;
    if(postal) {
        const headerAt=lines.findIndex(line=>line.startsWith('d_codigo|'));
        if(headerAt!==1)fail('Cabecera postal inesperada');
        const columns=lines[headerAt].split('|');
        const expected=['d_codigo','d_asenta','D_mnpio','d_estado','c_estado','c_mnpio'];
        if(expected.some(k=>!columns.includes(k)))fail('Columnas postales ausentes');
        const grouped=new Map();
        for(const line of lines.slice(headerAt+1)) {
            const values=line.split('|');if(values.length!==columns.length)fail('Fila postal incompleta');
            const row=Object.fromEntries(columns.map((k,i)=>[k,values[i]])), code=row.d_codigo;
            if(!/^\d{5}$/.test(code)||!/^\d{2}$/.test(row.c_estado)||!/^\d{3}$/.test(row.c_mnpio))fail('Clave postal inválida');
            if(!grouped.has(code))grouped.set(code,{code,labels:new Set(),municipalities:new Set()});
            const item=grouped.get(code);item.labels.add(row.D_mnpio+', '+row.d_estado);item.municipalities.add(row.c_estado+row.c_mnpio);
        }
        for(const item of grouped.values())entries.push({code:item.code,label:[...item.labels].sort().join(' / ').slice(0,500),attributes:{municipalities:[...item.municipalities].sort().join(',')}});
        mapping={member,code:'d_codigo',label:['D_mnpio','d_estado'],grouping:'one code; distinct municipalities; no address inference'};
    } else {
        const count=family==='inegi.state'?4:family==='inegi.municipality'?6:9;
        const columns=csvPrefix(lines[0],count), name=family==='inegi.state'?'NOM_ENT':family==='inegi.municipality'?'NOM_MUN':'NOM_LOC';
        if(columns[0]!=='CVEGEO'||!columns.includes(name)||!columns.includes('CVE_ENT'))fail('Cabecera INEGI inesperada');
        for(const line of lines.slice(1)) {
            const values=csvPrefix(line,count), row=Object.fromEntries(columns.map((k,i)=>[k,values[i]])), code=row.CVEGEO;
            if(!new RegExp('^\\d{'+lengths[family]+'}$').test(code)||code.slice(0,2)!==row.CVE_ENT)fail('Clave INEGI incompatible con NC1');
            if(row.CVE_MUN&&code.slice(2,5)!==row.CVE_MUN)fail('Municipio INEGI inconsistente');
            if(row.CVE_LOC&&code.slice(5)!==row.CVE_LOC)fail('Localidad INEGI inconsistente');
            if(row.Estatus)fail('Archivo incluye bajas: revisar fuente');
            if(/^00/.test(code)||(code.length>=5&&code.slice(2,5)==='000')||(code.length===9&&code.slice(5)==='0000'))fail('Centinela geográfico');
            entries.push({code,label:row[name],attributes:{entity:row.CVE_ENT,...(row.CVE_MUN?{municipality:row.CVE_ENT+row.CVE_MUN}:{})}});
        }
        mapping={member,code:'CVEGEO',label:name,prefixColumns:count};
    }
    const manifest={releaseId,family,sourceCatalogName:getFamily(family).sourceCatalogName,sourceUrl,sourceVersion,downloadedAt,sha256:sha256(buffer),encoding,
        validFrom:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(downloadedAt)),validTo:null,validityBasis:'download_date',provenance:'official',status:'staged',verifiedAt:null,columnMapping:{...mapping,downloadDateTimeZone:'America/Mexico_City'}};
    return buildRelease(manifest,entries);
}
module.exports={importGeographicZip,csvPrefix};
