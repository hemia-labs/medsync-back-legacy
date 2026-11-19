'use strict';
// Disposable MySQL only: loopback port, empty synthetic DB, no volumes or .env.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const mysql=require('mysql2/promise');
const {Sequelize}=require('sequelize');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sql=fs.readFileSync(require('node:path').join(__dirname,'../migrations/20261119_shared_document_logo.sql'),'utf8');
(async()=>{
 for(const version of ['8.0','8.4']){
  const name='shared-logo-qa-'+process.pid+'-'+version.replace('.','');let connection,db;
  try{
   docker(['run','--rm','-d','--name',name,'-e','MYSQL_ALLOW_EMPTY_PASSWORD=yes','-e','MYSQL_DATABASE=qa_shared_logo','-p','127.0.0.1::3306','mysql:'+version]);
   const port=Number(docker(['port',name,'3306/tcp']).split(':').pop());
   for(let attempt=0;attempt<60;attempt++){
    try{connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',database:'qa_shared_logo',connectTimeout:1000});break;}catch(_){await delay(1000);}
   }
   assert.ok(connection,'Disposable database ready');
   await connection.query("CREATE TABLE clinical_histories (id VARCHAR(50) PRIMARY KEY,status VARCHAR(30))");
   await connection.query("INSERT INTO clinical_histories VALUES ('legacy','FINALIZED')");
   await connection.query(sql);
   const [rows]=await connection.query('SELECT * FROM clinical_histories');assert.deepEqual(rows,[{id:'legacy',status:'FINALIZED',document_logo_snapshot_json:null}]);
   await connection.query("INSERT INTO clinical_histories (id,status,document_logo_snapshot_json) VALUES ('new','FINALIZED',?)",[JSON.stringify({v:1,logo:'data:image/png;base64,QA',captured_at:new Date().toISOString()})]);
   const [oldReader]=await connection.query('SELECT id,status FROM clinical_histories');assert.equal(oldReader.length,2,'Old reader ignores the additive column');
   await connection.query('CREATE TABLE business (id_business VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,active INT,logo_url LONGTEXT)');
   await connection.query("INSERT INTO business VALUES ('tenant',1,'consultorios/tenant/logos/aaaa.png')");
   await connection.end();connection=null;
   db=new Sequelize('qa_shared_logo','root','',{host:'127.0.0.1',port,dialect:'mysql',logging:false,pool:{max:2,min:0}});
   const dbId=require.resolve('../../src/db/Sequelize.connection');require.cache[dbId]={id:dbId,filename:dbId,loaded:true,exports:db};
   const imageId=require.resolve('../../src/services/aws/privateImages');require.cache[imageId]={id:imageId,filename:imageId,loaded:true,exports:{isPrivateKey:v=>v.startsWith('consultorios/'),inlineImage:async()=> 'data:image/png;base64,QA'}};
   delete require.cache[require.resolve('../../src/services/documentLogo')];const logo=require('../../src/services/documentLogo');
   const tx=await db.transaction({isolationLevel:Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED});
   assert.equal(await logo.capture('tenant',tx),'data:image/png;base64,QA');
   let replaced=false;const replacement=db.query("UPDATE business SET logo_url='replacement' WHERE id_business='tenant'").then(()=>{replaced=true;});
   await delay(150);assert.equal(replaced,false,'Replacement waits while document holds the object reference');
   await tx.commit();await replacement;assert.equal(replaced,true);
   console.log('PASS MySQL '+version+': additive migration, legacy NULL, old reader, actual capture SQL and READ-COMMITTED replacement serialization.');
  }finally{if(connection)await connection.end();if(db)await db.close();try{docker(['rm','-f',name]);}catch(_){}}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
