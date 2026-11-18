'use strict';
const fs=require('node:fs');
const {importGeographicZip}=require('../../src/domain/sisCatalog/geographicImporter');
const {writeStagedRelease,readStagedRelease}=require('../../src/domain/sisCatalog/stagedRelease');
function main(){
    const args=process.argv.slice(2),a={};
    for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('INVALID_ARGUMENT');a[args[i].slice(2)]=args[i+1];}
    for(const key of ['file','member','family','release-id','source-url','downloaded-at','out'])if(!a[key])throw Error('MISSING_'+key);
    const release=importGeographicZip(fs.readFileSync(a.file),{family:a.family,member:a.member,releaseId:a['release-id'],sourceUrl:a['source-url'],sourceVersion:a['source-version']||null,downloadedAt:a['downloaded-at']});
    writeStagedRelease(a.out,release);
    const back=readStagedRelease(a.out,release.manifest.releaseId).release;
    console.log(JSON.stringify({releaseId:back.manifest.releaseId,entries:back.entryCount,sha256:back.manifest.sha256,contentSha256:back.contentSha256}));
}
if(require.main===module)try{main();}catch(e){console.error(e.code||'CATALOG_STAGE_FAILED',e.message);process.exitCode=1;}
