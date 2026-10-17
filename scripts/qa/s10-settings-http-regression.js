const assert=require('node:assert/strict');
const base='http://localhost:3009/api';
const origin='http://localhost:4324';

(async()=>{
 assert.ok(process.env.S10_QA_PASSWORD,'Set S10_QA_PASSWORD for disposable QA accounts');
 for(const phone of ['5510000211','5510000221']) {
  const cookies=new Map();let csrf=null;let signedIn=false;
  async function request(route,method='GET',body) {
   const response=await fetch(base+route,{method,headers:{Origin:origin,Referer:origin+'/',Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; '),...(body ? {'Content-Type':'application/json'} : {}),...(csrf ? {[csrf.headerName]:csrf.csrfToken} : {})},...(body ? {body:JSON.stringify(body)} : {})});
   for(const cookie of response.headers.getSetCookie()) {const first=cookie.split(';')[0],split=first.indexOf('=');cookies.set(first.slice(0,split),first.slice(split+1));}
   return {status:response.status,data:await response.json()};
  }
  try {
   csrf=(await request('/auth/csrf')).data.data;
   const login=await request('/auth/login','POST',{param:phone,pwd:process.env.S10_QA_PASSWORD});assert.equal(login.status,200,login.data.message);signedIn=true;
   const session=await request('/auth/session');assert.equal(session.status,200,session.data.message);assert.ok(Array.isArray(session.data.data.permissions),'Hydrated session carries effective permissions');
   csrf=(await request('/auth/csrf')).data.data;
   assert.equal((await request('/rol/permissions/ROL-DOCTOR')).status,403);
   assert.equal((await request('/rol/permissions/qa-s10-nonexistent-role','PUT',{permissions:[]})).status,403,'Authenticated role cannot invoke permission writes; invalid target additionally prevents any mutation');
   if(phone==='5510000211') {
    assert.equal((await request('/prescription/config?doctor_profile_id=QAC_DOCTOR_2_PROFILE')).status,403,'Doctor cannot read another doctor settings');
    assert.equal((await request('/prescription/config?doctor_profile_id=QAC_DOCTOR_1_PROFILE')).status,200);
   }
   console.log('PASS S10 HTTP: '+(phone==='5510000211' ? 'doctor' : 'assistant')+' denied administrative permission endpoints.');
  } finally {if(signedIn)await request('/auth/close','PUT',{});}
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
