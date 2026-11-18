'use strict';
// Audit by default. Explicit --apply --verify --database <exact target> for a reviewed source.
const { readStagedRelease } = require('../../src/domain/sisCatalog/stagedRelease');
const { installRelease } = require('../../src/domain/sisCatalog/installRelease');
async function main() {
    const args = process.argv.slice(2), options = {};
    for (let i=0;i<args.length;i++) { const key=args[i]; if(['--apply','--verify','--ack-numeric-codes'].includes(key))options[key]=true; else if(['--dir','--release','--source-sha256','--database'].includes(key))options[key]=args[++i]; else throw Error('UNKNOWN_ARGUMENT'); }
    const {release,issues}=readStagedRelease(options['--dir'],options['--release']);
    if(issues.some(i=>i.code!=='NUMERIC_CODE_CELLS'||!options['--ack-numeric-codes']))throw Error('CATALOG_REVIEW_ISSUES_FIRST');
    if(release.manifest.sha256!==options['--source-sha256'])throw Error('CATALOG_SOURCE_HASH_MISMATCH');
    if(!options['--apply'])return console.log(JSON.stringify({mode:'audit',releaseId:release.manifest.releaseId,entries:release.entryCount,sha256:release.manifest.sha256,contentSha256:release.contentSha256}));
    const config=require('../../src/config/config');
    if(!options['--database']||config.DATABASEMYSQL!==options['--database'])throw Error('CATALOG_DATABASE_TARGET_MISMATCH');
    const conn=await require('mysql2/promise').createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL,timezone:'Z'});
    try {console.log(JSON.stringify(await installRelease(conn,release,{verify:Boolean(options['--verify']),sourceSha256:options['--source-sha256']})));} finally {await conn.end();}
}
// Print only a stop code (e.g. CATALOG_REVIEW_ISSUES_FIRST, CATALOG_DATABASE_TARGET_MISMATCH); never messages that may hold config.
if(require.main===module)main().catch(e=>{console.error(e.code||(/^[A-Z0-9_]{3,64}$/.test(e.message)?e.message:'CATALOG_INSTALL_FAILED'));process.exitCode=1;});
