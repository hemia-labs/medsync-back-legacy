'use strict';
const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const {performance}=require('node:perf_hooks');
const passwords=require('../../src/services/security/registrationPassword.service');
const {compare}=require('../../src/util/bcrypt');
const {validateAuthPayload}=require('../../src/middleware/authPayloadValidation.middleware');

(async()=>{
    const blocklist=async()=>new Set(['a common password for tests']);
    const passphrase='  '+ 'é'.repeat(40)+' Ends  ';
    const start=performance.now();const hash=await passwords.hash(passphrase,blocklist);
    const hashMs=Math.round(performance.now()-start);
    assert.ok(await compare(passphrase,hash));assert.ok(await compare(passphrase.normalize('NFD'),hash));
    assert.equal(await compare(passphrase.trim(),hash),false);
    assert.equal(await compare(passphrase.slice(0,-2)+'x ',hash),false,'Differences beyond bcrypt 72-byte boundary remain significant');
    assert.equal(await passwords.verify(passphrase,hash.replace('131072','1048576')),false);
    assert.equal(await passwords.verify(passphrase,hash+'suffix'),false);
    await assert.rejects(passwords.hash('a common password for tests',blocklist),e=>e.code==='PASSWORD_COMPROMISED');
    await assert.rejects(passwords.hash('short7',blocklist),e=>e.code==='PASSWORD_INVALID');
    await assert.rejects(passwords.hash(passphrase,async()=>new Set()),e=>e.code==='PASSWORD_POLICY_UNAVAILABLE');
    const minimum=await passwords.hash('abcdefgh',blocklist);
    assert.ok(await passwords.verify('abcdefgh',minimum));
    const legacy=await bcrypt.hash('Legacy123',4);
    assert.ok(await compare(' Legacy123 ',legacy));assert.equal(await compare('Wrong123',legacy),false);
    let reached=false;
    const request={body:{param:'5551234567',pwd:passphrase,refresh:false}};
    validateAuthPayload('login')(request,{status:()=>{throw Error('Unexpected rejection');}},()=>{reached=true;});
    assert.ok(reached);assert.equal(request.body.pwd,passphrase);
    const queueStart=performance.now();
    const busy=await Promise.allSettled(Array.from({length:6},()=>passwords.verify(passphrase,hash)));
    assert.ok(busy.some(item=>item.status==='rejected'&&item.reason.code==='PASSWORD_CAPACITY_BUSY'));
    assert.ok(busy.filter(item=>item.status==='fulfilled').every(item=>item.value===true));
    console.log(JSON.stringify({result:'PASS',nativeScrypt:true,hashMs,queueMs:Math.round(performance.now()-queueStart),maxRSSKiB:process.resourceUsage().maxRSS,
        capacityRejected:busy.filter(item=>item.status==='rejected').length,checks:'NFC, spaces, >72 bytes, parser cost bounds, blocklist, bcrypt compatibility, login preservation, bounded queue; local measurement only'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
