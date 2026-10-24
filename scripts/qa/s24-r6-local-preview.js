'use strict';
// Standalone isolated QA harness, never imported by src/index.js. No configured
// DB writes, real mail or payment provider. Run with S24_QA_ISOLATED=1.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../../..');
async function prepare(db) {
    const tables=['appointment_working_day','appointment_time_range','document_templates','document_template_versions',
        'prescription_config','login_image_configuration','clinical_module_config'];
    for(const name of tables) {
        const source=await fs.readFile(path.join(root,'u575589445_orrico/Tables',name+'.sql'),'utf8');
        const ddl=source.match(/CREATE TABLE[\s\S]*?;\s*$/)?.[0];
        if(!ddl || /DROP\s+TABLE/i.test(ddl))throw Error('Invalid schema-only fixture');
        await db.query(ddl);
    }
    await db.query('ALTER TABLE appointment_config ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1');
    for(const name of ['SP_login_image_configuration_get','SP_ui_theme_get','SP_ui_theme_list','SP_clinical_module_config_get']) {
        const source=await fs.readFile(path.join(root,'u575589445_orrico/Procedures',name+'.sql'),'utf8');
        const ddl=source.slice(source.indexOf('CREATE '),source.lastIndexOf('//')).replace(/CREATE DEFINER=.*? PROCEDURE/,'CREATE PROCEDURE').trim();
        await db.query(ddl);
    }
    for(const code of ['admin.config','admin.users','px.all','px.new']) {
        await db.query('INSERT INTO cat_permission(id_cat_permission,code,name,description) VALUES (:code,:code,:code,:description)',
            {replacements:{code,description:'Synthetic local R6 permission'}});
        await db.query("INSERT INTO permission_rol(id_permission_rol,id_rol,id_cat_permission) VALUES (UUID(),'admin',:code)",{replacements:{code}});
    }
}
function extendApp(app) {
    app.use('/api/business',require('../../src/routes/mysql/business'));
    app.use('/api/saas-legal',require('../../src/routes/mysql/saas-legal'));
    // Real read-only configuration handlers for Summary. Do not expose uploads
    // or integrations in this preview.
    const token=require('../../src/auth/authenticate'),operational=require('../../src/middleware/requireTenantOperational.middleware');
    const config=require('../../src/controller/mysql/config.controller');
    for(const [route,method] of [['login-image/get','loginImageGet'],['theme/get','themeGet'],['theme/list','themeList']])
        app.get('/api/config/'+route,token.OptionalAuth,config[method]);
    app.get('/api/config/clinical-modules/get',token.Auth,operational,config.clinicalModuleConfigGet);
    app.get('/api/user/professional-profile/me',token.Auth,operational,require('../../src/controller/mysql/user.controller').getProfessionalProfile);
}
function html(content) {return '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buzón de prueba R6</title><style>body{font:18px/1.6 system-ui;max-width:680px;margin:40px auto;padding:20px;color:#153b36;background:#f4faf8}input,button,a{font:inherit}input{max-width:100%;padding:12px}a{display:inline-block;margin:12px 0;color:#096657}section{background:white;padding:24px;border:1px solid #bddbd0;border-radius:16px}</style><h1>Buzón de prueba R6</h1><p>Entorno aislado. Los mensajes se capturan aquí: no se envían a un correo real. Usa únicamente datos ficticios.</p><section>'+content+'</section><p><a href="http://127.0.0.1:4338/activar-cuenta">Volver a mi cuenta</a> · <a href="/">Actualizar buzón</a></p></html>';}
async function start() {
    const directory=path.join(root,'_qa/s24-r6');await fs.mkdir(directory,{recursive:true});
    const previous=process.argv.includes('--resume')?JSON.parse(await fs.readFile(path.join(directory,'preview.json'),'utf8')):null;
    const fixture=await require('./s24-registration-browser-fixture').start({activation:true,realConfiguration:true,prepare,extendApp,existingIsolatedDatabase:previous?.database});
    // The SQL unit fixture uses one dark placeholder for every theme token.
    // For a human preview, use the application's existing default palette.
    const themeSource=await fs.readFile(path.join(root,'hemia-assistance-front-legacy/src/plugins/theme.js'),'utf8');
    const themeBlock=themeSource.match(/const DEFAULT_THEME = \{([\s\S]*?)\};/)?.[1];
    if(!themeBlock)throw Error('Default preview theme not found');
    const colors=[...themeBlock.matchAll(/([a-z0-9_]+): '(#[A-Fa-f0-9]{6})'/g)];
    if(!colors.length)throw Error('Default preview colors not found');
    await fixture.db.query('UPDATE cat_ui_theme SET name=:name,'+colors.map(([,key])=>'`'+key+'`=:'+key).join(',')+' WHERE code=:code',
        {replacements:{name:'MedSync QA',code:'medical-blue',...Object.fromEntries(colors.map(([,key,value])=>[key,value]))}});
    // No OTP/cookies/passwords persisted in this manifest or logs.
    await fs.writeFile(path.join(directory,'preview.json'),JSON.stringify({database:fixture.database,api:'http://127.0.0.1:4337',frontend:'http://127.0.0.1:4338',mailbox:'http://127.0.0.1:4339',pid:process.pid},null,2));
    const mailbox=http.createServer(async(req,res)=>{
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
        res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'");
        if(req.method!=='GET' || req.url!=='/'){res.writeHead(404);return res.end();}
        try {
            const response=await fetch('http://127.0.0.1:4337/api/auth/session',{headers:{cookie:req.headers.cookie||''}});
            const body=await response.json(),user=body.data?.user;
            if(!response.ok || !body.data?.authenticated || !user){res.writeHead(401);return res.end(html('<p>Inicia sesión en la cuenta de prueba para consultar su código.</p>'));}
            const message=fixture.deliveries.filter(item=>item.to===user.email).at(-1);
            if(!message)return res.end(html('<p>Aún no hay un código para esta cuenta. Solicítalo desde la pantalla de verificación.</p>'));
            // Captured code is visible only to its authenticated recipient. Fixed
            // six digits; no injected HTML or other users' private destinations.
            if(!/^\d{6}$/.test(message.code))throw Error();
            res.end(html('<h2>Código de verificación</h2><p>Último mensaje capturado para tu cuenta de prueba.</p><label for="qa-code">Código de 6 dígitos</label><br><input id="qa-code" readonly value="'+message.code+'" aria-label="Código de 6 dígitos"><p>Vigencia: 10 minutos desde el envío. Si ya venció, solicita otro.</p>'));
        }catch(_){res.writeHead(503);res.end(html('<p>No pudimos consultar la sesión. Reintenta.</p>'));}
    });
    await new Promise(resolve=>mailbox.listen(4339,'127.0.0.1',resolve));
    console.log('R6 isolated preview ready: frontend 4338, API 4337, captured mailbox 4339. No real mail or payments.');
    return {...fixture,mailbox,close:async()=>{await new Promise(resolve=>mailbox.close(resolve));await fixture.close();}};
}
if(require.main===module)start().then(fixture=>{
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>fixture.close().then(()=>process.exit(0)));
}).catch(error=>{console.error(error.code==='MODULE_NOT_FOUND'?error.message:(error.code||error.message));process.exitCode=1;});
module.exports={start,prepare};
