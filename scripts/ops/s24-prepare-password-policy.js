'use strict';
// Public common-password corpus only; never reads users' credentials.
// Downloaded text is parsed as data, never executed. No environment edits.
const fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto');
const revision='a61e8f503c54bf3c399b8f9e4da97e7059a8437e';
const base=`https://raw.githubusercontent.com/danielmiessler/SecLists/${revision}/`;
async function download(relative,maxBytes) {
    const response=await fetch(base+relative,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('PASSWORD_SOURCE_UNAVAILABLE');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!bytes.length||bytes.length>maxBytes)throw Error('PASSWORD_SOURCE_SIZE_INVALID');
    return bytes;
}
async function main() {
    const relative='Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt';
    const corpus=await download(relative,2*1024*1024);
    const license=await download('LICENSE',20000);
    if(!license.toString('utf8').includes('MIT License'))throw Error('PASSWORD_SOURCE_LICENSE_CHANGED');
    const passwords=[...new Set(corpus.toString('utf8').split(/\r?\n/).filter(Boolean).map(value=>value.normalize('NFC').toLowerCase()))];
    if(passwords.length<90000)throw Error('PASSWORD_SOURCE_INCOMPLETE');
    const directory=path.resolve(__dirname,'../../config/security');
    await fs.mkdir(directory,{recursive:true});
    const payload=JSON.stringify({version:`seclists-ncsc-100k-${revision}`,source:base+relative,license:'MIT; see SecLists-LICENSE.txt',
        sourceSha256:createHash('sha256').update(corpus).digest('hex'),passwords});
    const filename=path.join(directory,'registration-password-blocklist.json');
    await fs.writeFile(filename,payload+'\n');
    await fs.writeFile(path.join(directory,'SecLists-LICENSE.txt'),license);
    const digest=createHash('sha256').update(payload+'\n').digest('hex');
    console.log(JSON.stringify({file:'config/security/registration-password-blocklist.json',entries:passwords.length,sha256:digest,revision}));
}
if(require.main===module)main().catch(error=>{console.error(/^PASSWORD_SOURCE_/.test(error.message)?error.message:'PASSWORD_POLICY_PREPARATION_FAILED');process.exitCode=1;});
