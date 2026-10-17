'use strict';

// Uses only the newly created accounts. Credentials/cookies never go to output.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const access=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../.alameda-access.local'),'utf8'));
const base='http://localhost:3009/api',origin='http://localhost:4324';
const cookies=new Map();let csrf=null,signedIn=false;
async function request(route,method='GET',body) {
    const headers={Origin:origin,Referer:`${origin}/`,Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; ')};
    if(body)headers['Content-Type']='application/json';
    if(csrf)headers[csrf.headerName]=csrf.csrfToken;
    const response=await fetch(base+route,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    for(const cookie of response.headers.getSetCookie()){const first=cookie.split(';')[0],at=first.indexOf('=');cookies.set(first.slice(0,at),first.slice(at+1));}
    const data=await response.json();
    return {status:response.status,data};
}
const ok=(response,label)=>{assert.equal(response.status,200,`${label}: HTTP ${response.status}`);return response.data.data;};
async function main(){
    const checks=[];
    try{
        csrf=ok(await request('/auth/csrf'),'CSRF');
        ok(await request('/auth/login','POST',{param:access.doctor.telephone,pwd:access.doctor.password}),'Doctor login');signedIn=true;
        const session=ok(await request('/auth/session'),'Doctor session');
        assert.ok(Array.isArray(session.permissions)&&session.permissions.length>0,'Permissions loaded');checks.push('doctor login and permissions');
        ok(await request('/business/current'),'Professional business');
        const doctors=ok(await request('/appointment/doctors'),'Doctor options');
        assert.equal(doctors.length,1,'Professional has exactly one available doctor');checks.push('one Professional doctor');
        const profile=doctors[0].id_doctor_professional_profile;
        const agenda=ok(await request(`/appointment/config?doctor_profile_id=${profile}`),'Doctor agenda');assert.ok(agenda.enabled&&agenda.businessEnabled);
        const appointments=ok(await request('/appointment/list?date_from='+access.referenceDate),'Appointments');assert.ok(appointments.length>0);checks.push('agenda configuration and upcoming appointments');
        const home=ok(await request('/home/continuity-summary?scope=tenant'),'Home');assert.ok(home.sections);checks.push('home continuity');
        const dashboard=ok(await request('/business/dashboard/summary?scope=tenant'),'Dashboard');
        assert.ok(dashboard.activity.appointmentsCreated>0&&dashboard.activity.clinicalHistoriesFinalized>0&&dashboard.activity.prescriptionsIssued>0);checks.push('populated clinical and operational KPI');
        ok(await request('/business/dashboard/trends?scope=tenant'),'Dashboard trends');
        ok(await request('/business/dashboard/operational-summary?scope=tenant'),'Operational summary');checks.push('trends and operational summary');
        const prescriptions=ok(await request('/prescription/list'),'Prescriptions');assert.ok(prescriptions);checks.push('prescriptions readable');
        csrf=ok(await request('/auth/csrf'),'Doctor logout CSRF');ok(await request('/auth/close','PUT',{}),'Doctor logout');signedIn=false;
        cookies.clear();csrf=ok(await request('/auth/csrf'),'Assistant CSRF');
        ok(await request('/auth/login','POST',{param:access.assistant.telephone,pwd:access.assistant.password}),'Assistant login');signedIn=true;
        ok(await request('/auth/session'),'Assistant session');checks.push('assistant login');
        const assistantDashboard=ok(await request('/business/dashboard/summary?scope=tenant'),'Assistant operational indicators');
        assert.equal(assistantDashboard.access.families.financial,false,'Assistant cannot see financial KPI');
        assert.equal(assistantDashboard.access.families.clinical,false,'Assistant cannot see clinical KPI');
        checks.push('assistant restricted to operational KPI');
        console.log(JSON.stringify({status:'PASS',checks,kpis:dashboard.activity,upcomingAppointments:appointments.length,secretOutput:false},null,2));
    }finally{
        if(signedIn){csrf=ok(await request('/auth/csrf'),'Logout CSRF');ok(await request('/auth/close','PUT',{}),'Logout');}
    }
}
main().catch(error=>{console.error(JSON.stringify({status:'FAIL',error:error.code||error.name,detail:error.code==='ERR_ASSERTION'?error.message:undefined}));process.exitCode=1;});
