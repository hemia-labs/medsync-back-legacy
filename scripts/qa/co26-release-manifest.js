'use strict';
// Reproducible local source identity; never loads environment or clinical data.
const fs=require('node:fs/promises'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
async function repository(name){
 const cwd=path.join(root,name),git=args=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 const candidates=[...new Set([...git(['diff','--name-only']).split('\n'),...git(['ls-files','--others','--exclude-standard']).split('\n')])].filter(file=>/^(src|scripts|docs)\//.test(file)&&/\.(js|cjs|vue|md)$/.test(file)).sort();
 const sources=[];for(const file of candidates){try{sources.push({file,sha256:digest(await fs.readFile(path.join(cwd,file)))});}catch(error){if(error.code!=='ENOENT')throw error;}}
 return{name,branch:git(['branch','--show-current']),head:git(['rev-parse','HEAD']),uncommitted:git(['status','--porcelain']).length>0,sources};
}
(async()=>{
 const evidence=path.join(root,'roadmap/evidence/CO26');
 const tests=[];for(const file of ['authenticated-mysql-results.json','configured-mysql-results.json']){const data=await fs.readFile(path.join(evidence,file));const result=JSON.parse(data);if(!result.pass)throw Error('FAILED_EVIDENCE');tests.push({file,sha256:digest(data),checks:result.checks.length,checked_at:result.checked_at});}
 const repositories=[];for(const name of ['medsync-back-legacy','medsync-front-legacy'])repositories.push(await repository(name));
 await fs.writeFile(path.join(evidence,'technical-delivery.json'),JSON.stringify({generated_at:new Date().toISOString(),runtime:process.version,scope:'Local technical validation; clinical/device acceptance and destination release pending',deployed:false,real_grants_applied:false,repositories,tests},null,2));
 console.log('PASS source/evidence manifest written without environment values or clinical content.');
})().catch(error=>{console.error('CO26 manifest:',error.code||error.message);process.exitCode=1;});
