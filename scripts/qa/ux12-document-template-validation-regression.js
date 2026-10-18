'use strict';
const assert = require('node:assert/strict');
const { validateDocumentTemplate } = require('../../src/validators/documentTemplate.validator');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=';
for(const html of ['','   ','<p><br></p>','<p>&nbsp;&#160;&#x200b;&shy;</p>','<script>Only removed content</script>','<img src="javascript:alert(1)">','<img alt="Sin imagen">']) {
    const result=validateDocumentTemplate({name:'Formato',content_html:html});
    assert.equal(result.isValid,false,html);assert.ok(result.fieldErrors.content_html);
}
assert.equal(validateDocumentTemplate({name:'   ',content_html:'<p>Texto</p>'}).isValid,false);
assert.equal(validateDocumentTemplate({name:{},content_html:'<p>Texto</p>'}).isValid,false);
for(const html of ['<p>Contenido clínico</p>','<p>{{nombrePaciente}}</p>',`<img src="${png}">`]) assert.equal(validateDocumentTemplate({name:' Formato ',content_html:html}).isValid,true,html);
const sanitized=validateDocumentTemplate({name:' Formato ',content_html:'<p>Contenido</p><script>attack()</script>'});
assert.equal(sanitized.data.name,'Formato');assert.equal(sanitized.data.content_html,'<p>Contenido</p>');

function stub(modulePath,exports) {const id=require.resolve(modulePath);require.cache[id]={id,filename:id,loaded:true,exports};}
let transactions=0,writes=0,version=null,meta=null;
stub('../../src/db/Sequelize.connection',{ async transaction(){transactions++;return {commit:async()=>{},rollback:async()=>{}};},async query(sql,options){
    assert.ok(options.transaction);assert.equal(options.replacements._id_document_template!==undefined,true);
    if(sql.includes('MAX(version_number)'))return [{next_version:1}];
    writes++;
    if(sql.includes('INSERT INTO document_templates'))meta=options.replacements;
    if(sql.includes('INSERT INTO document_template_versions'))version=options.replacements;
    return [];
} });
stub('../../src/util/effectivePermissions',{});
const dao=require('../../src/Dao/mysql/document.dao');
dao.hasPermission=async()=>true;
dao.resolveTemplateLicensingMetadata=()=>({});
dao.enforceTemplateLicensing=async()=>null;
dao.listTemplates=async()=>({status:200,data:[]});
const body={id_login:'qa-actor',id_business:'qa-tenant',name:' Formato ',content_html:'<p>Texto válido</p>'};
(async()=>{
    let result=await dao.saveTemplate({...body,name:' ',content_html:'<p>&nbsp;</p>'});
    assert.equal(result.status,400);assert.ok(result.data.fieldErrors.name);assert.ok(result.data.fieldErrors.content_html);assert.equal(transactions,0);assert.equal(writes,0);
    result=await dao.saveTemplate({...body,content_html:'<script>attack()</script>'});assert.equal(result.status,400);assert.equal(writes,0);
    result=await dao.saveTemplate({...body,content_html:'<p>Contenido seguro</p><script>attack()</script>'});
    assert.equal(result.status,200);assert.equal(meta._name,'Formato');assert.equal(version._content_html,'<p>Contenido seguro</p>');assert.equal(transactions,1);
    dao.hasPermission=async()=>false;result=await dao.saveTemplate(body);assert.equal(result.status,401);assert.equal(transactions,1,'Denied actors never reach writes or a new transaction');
    console.log('PASS UX12 document formats: meaningful sanitized text/variables/images, empty/invisible/removed content rejected before transaction, normalized name, safe version payload and unchanged permission gate. Mock SQL; no drafts, historical snapshots or database changed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
