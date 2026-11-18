'use strict';
// Only this disposable container is removed. No project configuration, tunnel or shared database is used.
const {spawnSync,spawn}=require('node:child_process');
const image=process.argv[2]||'mysql:8.0';
if(!['mysql:8.0','mysql:8.4'].includes(image))throw Error('Use mysql:8.0 or mysql:8.4');
const name='nc1-clues-qa-'+process.pid+'-'+Date.now();
function docker(args,quiet=false){const r=spawnSync('docker',args,{encoding:'utf8',stdio:quiet?'pipe':'inherit'});if(r.status!==0)throw Error('Isolated docker command failed: '+args[0]);return r.stdout;}
async function main(){
    try{
        docker(['run','--rm','-d','--name',name,'-p','127.0.0.1:33381:3306','-e','MYSQL_ROOT_PASSWORD=nc1-synthetic-only',image],true);
        let ready=false;
        for(let n=0;n<90;n++){
            const r=spawnSync('docker',['exec',name,'mysql','-uroot','-pnc1-synthetic-only','-N','-e','SELECT 1'],{stdio:'ignore'});
            if(r.status===0){ready=true;break;}
            await new Promise(resolve=>setTimeout(resolve,1000));
        }
        if(!ready)throw Error('Isolated MySQL readiness timed out');
        console.log('Disposable MySQL ready:',image);
        const tests=['nc1-clues-mysql.test.js','nc1-identity.test.js','nc1-catalogs.test.js','nc1-identity-mysql.test.js','nc1-patient-flows.test.js','nc1-professional-flow.test.js','nc1-identity-integrated-mysql.test.js','nc1-installation.test.js'];
        process.exitCode=await new Promise(resolve=>{const child=spawn(process.execPath,['--test',...tests.map(f=>'scripts/qa/'+f)],{stdio:'inherit',env:{...process.env,NC1_ISOLATED_QA:'1'}});child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});
    }finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'});console.log('Disposable container removed:',name);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
