/* SES v2 offline regression: real service/provider/SendEmailCommand, stub clients.
 * Env values below are synthetic. No dotenv files, AWS calls or SMTP delivery. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const servicePath = path.join(root, 'src/services/email/email.service.js');
const providerPath = path.join(root, 'src/services/email/providers/ses.provider.js');
const mailPath = path.join(root, 'src/mail/mail.js');
const copy = value => JSON.parse(JSON.stringify(value));
const synthetic = {
    accessKey:'AKIA000000000000QA00',secret:'offline-only-synthetic-secret-access-key',session:'offline-only-synthetic-session-token',
    sdkError:'SYNTHETIC_PRIVATE_SDK_ERROR',privateLink:'https://qa.invalid/sign/d/offline-secret-token'
};
const base = {
    NODE_ENV:'test',APP_ENV:'test',ENVIRONMENT:'test',EMAIL_PROVIDER:'ses',AWS_REGION:'us-east-1',
    AWS_ACCESS_KEY_ID:synthetic.accessKey,AWS_SECRET_ACCESS_KEY:synthetic.secret,
    EMAIL_FROM_NAME:'MedSync QA',EMAIL_FROM_AUTH:'auth@example.test',EMAIL_FROM_NOTIFICATIONS:'notifications@example.test',EMAIL_REPLY_TO:'support@example.test',
    EMAIL_CONFIGURATION_SET_AUTH:'qa-auth-set',EMAIL_CONFIGURATION_SET_TRANSACTIONAL:'qa-transactional-set',
    EMAIL_PASSWORD_RESET_TEMPLATE:'Exact-Reset-Template-QA',EMAIL_DOCUMENT_SIGNATURE_TEMPLATE:'Exact-Signature-Template-QA',
    SMTP_HOST:'relay.qa.invalid',SMTP_PORT:'2525',SMTP_SECURE:'false',SMTP_USER:'synthetic-smtp-user',SMTP_PASSWORD:'synthetic-smtp-password',EMAIL_FROM:'legacy@example.test'
};
const envKeys=[...Object.keys(base),'AWS_SESSION_TOKEN','SMTP_PASS'];
const originalEnv=new Map(envKeys.map(key=>[key,process.env[key]]));
const originalLoad=Module._load;
const originalConsole={log:console.log,warn:console.warn,error:console.error};
const stdout=message=>originalConsole.log(message);
const results=[];
let sdk,clients=[],commands=[],transports=[],smtpMessages=[],logs=[],sdkReply,smtpReply,envLoads=0;
class OfflineSESClient {
    constructor(config) { this.config=config;clients.push(this); }
    async send(command) {
        assert.ok(command instanceof sdk.SendEmailCommand,'Provider must construct the real SDK SendEmailCommand');
        commands.push({client:this,input:copy(command.input)});
        if(sdkReply instanceof Error)throw sdkReply;
        return typeof sdkReply==='function' ? sdkReply(command) : sdkReply;
    }
    destroy() {}
}
function configure(overrides={}) {
    const env={...base,...overrides};
    for(const key of envKeys) {if(env[key]===undefined || env[key]===null)delete process.env[key];else process.env[key]=String(env[key]);}
    clients=[];commands=[];transports=[];smtpMessages=[];logs=[];
    sdkReply={MessageId:'synthetic-ses-message'};smtpReply={messageId:'synthetic-smtp-message'};
    for(const file of [servicePath,providerPath,mailPath]) {try {delete require.cache[require.resolve(file)];} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;}}
    return require(servicePath);
}
async function check(name,run) {
    try {await run();results.push({name,ok:true});stdout('PASS '+name);}
    catch(error) {results.push({name,ok:false});originalConsole.error('FAIL '+name+'\n'+error.stack);}
}
function assertSafeFailure(result,why='Rejected operation') {
    assert.equal(result && result.success,false,why);
    assert.equal(typeof result.provider,'string');assert.match(String(result.code),/^EMAIL_[A-Z0-9_]+$/);
    assert.equal(typeof result.message,'string');assert.ok(result.message.length>0);
    const serialized=JSON.stringify(result);
    for(const secret of [...Object.values(synthetic),'synthetic-smtp-password','004200'])assert.ok(!serialized.includes(secret),why+' must not expose private values');
    assert.doesNotMatch(serialized,/InjectedHeader|AWS_RAW_ERROR|\r|\n|"stack"|"\$metadata"/);
}
function assertNoSecretLogs() {
    const rendered=logs.flat().map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' ');
    for(const secret of [...Object.values(synthetic),'synthetic-smtp-password','004200'])assert.ok(!rendered.includes(secret),'Logs cannot contain credentials, codes, SDK error text or signature links');
}
const input=()=>commands[commands.length-1].input;
const data=()=>JSON.parse(input().Content.Template.TemplateData);
function assertTemplateOnly(request) {
    assert.deepEqual(Object.keys(request.Content),['Template'],'SES must use the configured template instead of local Simple/Raw HTML');
    assert.equal(request.Destination.ToAddresses.length,1);assert.deepEqual(Object.keys(request.Destination),['ToAddresses']);
    assert.equal(request.Content.Template.TemplateArn,undefined);assert.equal(request.Content.Template.TemplateContent,undefined);
    assert.equal(request.Content.Simple,undefined);assert.equal(request.Content.Raw,undefined);
}
function assertSimpleOnly(request) {
    assert.deepEqual(Object.keys(request.Content),['Simple'],'Locally rendered messages must send their subject, text and HTML through SES Simple content');
    assert.equal(request.Content.Template,undefined);assert.equal(request.Content.Raw,undefined);
    assert.deepEqual(Object.keys(request.Content.Simple),['Subject','Body']);
    assert.deepEqual(Object.keys(request.Content.Simple.Body),['Text','Html']);
}
function decodeEscapedText(value) {
    return String(value).replace(/&(amp|lt|gt|quot|#0*39|#x0*27);/gi,(_match,key)=>({amp:'&',lt:'<',gt:'>',quot:'"'}[key.toLowerCase()] || "'"));
}
function assertEscapedExactlyOnce(actual,plain) {
    assert.equal(decodeEscapedText(actual),plain,'A single HTML decode must restore the supplied plain value');
    assert.doesNotMatch(actual,/[<>"']/,'Raw markup delimiters cannot reach SES template data');
}
async function credentials(config) {return typeof config.credentials==='function' ? config.credentials() : config.credentials;}

(async()=>{
    assert.ok(fs.existsSync(providerPath),'SES provider source must exist before running this regression');
    sdk=require('@aws-sdk/client-sesv2');
    Module._load=function(request,parent,isMain) {
        if(/(?:^|\/)config\/env(?:\.js)?$/.test(request)) {envLoads++;return {};}
        if(request==='@aws-sdk/client-sesv2')return {...sdk,SESv2Client:OfflineSESClient};
        if(request==='nodemailer')return {createTransport:config=>{
            transports.push(copy(config));
            return {async sendMail(message) {smtpMessages.push(copy(message));return smtpReply;},async verify(){return true;}};
        }};
        return originalLoad.call(this,request,parent,isMain);
    };
    for(const name of ['log','warn','error'])console[name]=(...args)=>logs.push(args);

    await check('SES initialize validates configuration, uses one cached client and bounded timeouts without sending',async()=>{
        const service=configure({EMAIL_PROVIDER:' SES '});
        assert.equal(service.providerName(),'ses');
        const [first,second]=await Promise.all([service.initialize(),service.initialize()]);
        assert.equal(first.success,true);assert.equal(second.success,true);assert.equal(clients.length,1);assert.equal(commands.length,0);
        assert.equal(clients[0].config.region,'us-east-1');assert.equal(clients[0].config.maxAttempts,1,'A send must not be retried automatically into duplicate delivery');
        const actualCredentials=await credentials(clients[0].config);
        assert.equal(actualCredentials.accessKeyId,synthetic.accessKey);assert.equal(actualCredentials.secretAccessKey,synthetic.secret);assert.equal(actualCredentials.sessionToken,undefined);
        const handler=clients[0].config.requestHandler;
        const timeoutConfig=handler && (typeof handler.configProvider==='function' ? await handler.configProvider() : await handler.configProvider || handler.config || handler);
        assert.equal(timeoutConfig.connectionTimeout,5000);assert.equal(timeoutConfig.requestTimeout,15000);
        assert.equal(timeoutConfig.throwOnRequestTimeout,true,'Smithy must abort an expired request rather than merely warn about the timeout');
        await service.sendTransactionalEmail({type:'password-reset-code',to:'patient@example.test',variables:{code:'004200',ttlMinutes:12}});
        await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}});
        assert.equal(clients.length,1);assert.equal(commands.length,2);assert.equal(commands[0].client,commands[1].client);
        assertNoSecretLogs();
    });
    await check('password reset preserves leading zeroes, normalizes TTL and uses exact auth sender, template and configuration set',async()=>{
        const service=configure();
        const result=await service.sendTransactionalEmail({type:'password-reset-code',to:'patient@example.test',variables:{code:'004200',ttlMinutes:'15'},
            from:'attacker@example.test',templateName:'Wrong-Template',configurationSetName:'Wrong-Set',subject:'Ignore this',html:'<p>Ignore this</p>'});
        assert.equal(result.success,true);assert.equal(result.provider,'ses');assert.equal(result.messageId,'synthetic-ses-message');
        assertTemplateOnly(input());assert.deepEqual(input().Destination.ToAddresses,['patient@example.test']);
        assert.match(input().FromEmailAddress,/auth@example\.test/);assert.ok(input().FromEmailAddress.includes('MedSync QA'));assert.doesNotMatch(input().FromEmailAddress,/attacker/);
        assert.deepEqual(input().ReplyToAddresses,['support@example.test']);assert.equal(input().ConfigurationSetName,'qa-auth-set');assert.equal(input().Content.Template.TemplateName,'Exact-Reset-Template-QA');
        assert.deepEqual(data(),{code:'004200',ttlMinutes:15,html:{code:'004200',ttlMinutes:'15'}});
        for(const invalidTtl of [0,-1,'bad',null,Infinity]) {
            assert.equal((await service.sendTransactionalEmail({type:'password-reset-code',to:'patient@example.test',variables:{code:'123456',ttlMinutes:invalidTtl}})).success,true);
            assert.deepEqual(data(),{code:'123456',ttlMinutes:10,html:{code:'123456',ttlMinutes:'10'}});
        }
        assertNoSecretLogs();
    });
    await check('password-changed uses the branded local email and shares the configured auth channel',async()=>{
        const service=configure();
        assert.equal((await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{code:'004200',publicUrl:synthetic.privateLink,from:'attacker@example.test'}})).success,true);
        assertSimpleOnly(input());assert.equal(input().ConfigurationSetName,'qa-auth-set');
        assert.match(input().FromEmailAddress,/auth@example\.test/);assert.equal(input().Content.Simple.Subject.Data,'Tu contraseña de MedSync fue actualizada');
        assert.match(input().Content.Simple.Body.Html.Data,/Tu contraseña fue actualizada/);
        assert.match(input().Content.Simple.Body.Html.Data,/background:#f4f8f7/);
        assert.doesNotMatch(input().Content.Simple.Body.Html.Data,/004200|offline-secret-token|attacker@example\.test/);assertNoSecretLogs();
    });
    await check('document signature sends seven plain values plus seven escaped HTML copies, HTTPS links and the transactional channel',async()=>{
        const service=configure();
        const values={patientName:'Ana <QA> & "A" O\'B',clinicName:'Clínica <QA> & "B" O\'C',clinicLogoUrl:'https://qa.invalid/logo.png?a=1&b=2',
            documentTitle:'Consentimiento <QA> & "C" O\'D',doctorName:'Doctor <QA> & "D" O\'E',expiresAt:'17/10/2026 <QA> & "E" O\'F',publicUrl:'https://qa.invalid/sign/d/synthetic?a=1&b=2'};
        const result=await service.sendTransactionalEmail({type:'document-signature',to:'patient@example.test',variables:{...values,html:'<p>Not template data</p>',from:'attacker@example.test'}});
        assert.equal(result.success,true);assertTemplateOnly(input());assert.equal(input().Content.Template.TemplateName,'Exact-Signature-Template-QA');assert.equal(input().ConfigurationSetName,'qa-transactional-set');assert.match(input().FromEmailAddress,/notifications@example\.test/);
        const actual=data();assert.deepEqual(Object.keys(actual).sort(),[...Object.keys(values),'html'].sort());assert.deepEqual(Object.keys(actual.html).sort(),Object.keys(values).sort());
        for(const key of Object.keys(values)) {assert.equal(actual[key],values[key]);assertEscapedExactlyOnce(actual.html[key],values[key]);}
        assert.ok(!Object.values(actual.html).some(value=>String(value).includes('<table')),'Only escaped copies belong in html, not a locally rendered email body');
        assert.equal((await service.sendTransactionalEmail({type:'document-signature',to:'patient@example.test',variables:{publicUrl:values.publicUrl}})).success,true);
        const defaults={patientName:'paciente',clinicName:'Tu consultorio',clinicLogoUrl:'',documentTitle:'Documento para firma',doctorName:'',expiresAt:'la fecha indicada',publicUrl:values.publicUrl};
        assert.deepEqual(data(),{...defaults,html:{...defaults,publicUrl:'https://qa.invalid/sign/d/synthetic?a=1&amp;b=2'}});
        for(const logo of ['http://qa.invalid/logo.png','javascript:alert(1)','https://user:password@qa.invalid/logo.png','']) {
            assert.equal((await service.sendTransactionalEmail({type:'document-signature',to:'patient@example.test',variables:{publicUrl:values.publicUrl,clinicLogoUrl:logo}})).success,true);
            assert.equal(data().clinicLogoUrl,'','An invalid optional logo is discarded rather than preventing a signature notification');assert.equal(data().html.clinicLogoUrl,'');
        }
        assertNoSecretLogs();
    });
    await check('unknown types, invalid recipients, missing codes and invalid mandatory signature URLs fail before SDK send',async()=>{
        const messages=[
            {},null,{type:'unknown',to:'patient@example.test',variables:{}},
            ...[0,true,['document-signature'],{toString:()=> 'document-signature'}].map(type=>({type,to:'patient@example.test',variables:{publicUrl:'https://qa.invalid/sign/d/synthetic'}})),
            ...[undefined,'','bad-address','a@example.test,b@example.test','a@example.test\r\nBcc: injected@example.test',['patient@example.test'],{address:'patient@example.test'}].map(to=>({type:'password-changed',to,variables:{}})),
            ...[undefined,'',{},[],0,123456].map(code=>({type:'password-reset-code',to:'patient@example.test',variables:{code}})),
            ...[undefined,'','http://qa.invalid/sign','javascript:alert(1)','https://user:password@qa.invalid/sign','https://qa.invalid/sign\r\nInjectedHeader'].map(publicUrl=>({type:'document-signature',to:'patient@example.test',variables:{publicUrl}}))
        ];
        for(const message of messages) {
            const service=configure();assertSafeFailure(await service.sendTransactionalEmail(message),'Invalid typed email');assert.equal(commands.length,0);assertNoSecretLogs();
        }
    });
    await check('missing or injected SES configuration and incomplete temporary credentials are rejected before client creation',async()=>{
        const invalidConfigurations=[
            {AWS_REGION:undefined},{AWS_REGION:'not-a-region'},{AWS_REGION:'us-east-1\r\nInjectedHeader'},{AWS_REGION:'us-east-1\r\n'},
            {AWS_ACCESS_KEY_ID:undefined},{AWS_SECRET_ACCESS_KEY:undefined},{AWS_ACCESS_KEY_ID:undefined,AWS_SECRET_ACCESS_KEY:undefined},
            {AWS_ACCESS_KEY_ID:undefined,AWS_SECRET_ACCESS_KEY:undefined,AWS_SESSION_TOKEN:synthetic.session},
            {AWS_ACCESS_KEY_ID:synthetic.accessKey+'\r\n'},{AWS_SECRET_ACCESS_KEY:synthetic.secret+'\r\n'},{AWS_SESSION_TOKEN:synthetic.session+'\r\n'},
            {EMAIL_FROM_AUTH:undefined},{EMAIL_FROM_NOTIFICATIONS:undefined},{EMAIL_FROM_AUTH:'not-an-email'},{EMAIL_FROM_NOTIFICATIONS:'x@example.test\r\nBcc: injected@example.test'},
            {EMAIL_FROM_AUTH:'auth@example.test\r\n'},{EMAIL_FROM_NOTIFICATIONS:'\r\nnotifications@example.test'},
            {EMAIL_FROM_NAME:'MedSync\r\nInjectedHeader'},{EMAIL_FROM_NAME:'MedSync\r\n'},{EMAIL_REPLY_TO:'support@example.test\r\nInjectedHeader'},{EMAIL_REPLY_TO:'support@example.test\r\n'},
            {EMAIL_CONFIGURATION_SET_AUTH:undefined},{EMAIL_CONFIGURATION_SET_TRANSACTIONAL:undefined},
            {EMAIL_CONFIGURATION_SET_AUTH:'auth\r\nInjectedHeader'},{EMAIL_PASSWORD_RESET_TEMPLATE:undefined},{EMAIL_DOCUMENT_SIGNATURE_TEMPLATE:undefined},
            {EMAIL_PASSWORD_RESET_TEMPLATE:'Reset\r\nInjectedHeader'},{EMAIL_DOCUMENT_SIGNATURE_TEMPLATE:'Exact-Signature-Template-QA\r\n'},{EMAIL_CONFIGURATION_SET_AUTH:'qa-auth-set\r\n'}
        ];
        for(const override of invalidConfigurations) {
            const service=configure(override);assertSafeFailure(await service.initialize(),'Invalid SES startup configuration');assert.equal(clients.length,0);assert.equal(commands.length,0);assertNoSecretLogs();
        }
        const temporary=configure({AWS_SESSION_TOKEN:synthetic.session});assert.equal((await temporary.initialize()).success,true);
        assert.equal((await credentials(clients[0].config)).sessionToken,synthetic.session);assertNoSecretLogs();
    });
    await check('AWS rejection, unexpected SDK errors and absent MessageId are controlled without leaking raw errors or secrets',async()=>{
        for(const name of ['MessageRejected','ThrottlingException','Unexpected\r\nInjectedHeader']) {
            const service=configure();const failure=new Error('AWS_RAW_ERROR '+synthetic.sdkError+' '+synthetic.secret+' '+synthetic.privateLink+' 004200');
            failure.name=name;failure.code=synthetic.secret;failure.$metadata={requestId:synthetic.session};sdkReply=failure;
            assertSafeFailure(await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}}),'SDK failure');assert.equal(commands.length,1);assertNoSecretLogs();
        }
        const service=configure();sdkReply={};assertSafeFailure(await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}}),'Missing MessageId');assert.equal(commands.length,1);assertNoSecretLogs();
    });
    await check('SMTP raw compatibility and typed rendering work through a stub transport when SES is not selected',async()=>{
        const service=configure({EMAIL_PROVIDER:'smtp'});assert.equal(service.providerName(),'smtp');
        const legacy={to:'patient@example.test',subject:'Legacy subject',html:'<p>Legacy body</p>',text:'Legacy body'};
        assert.equal((await service.sendTransactionalEmail(legacy)).success,true);assert.equal(clients.length,0);assert.equal(commands.length,0);
        assert.equal(smtpMessages[0].from,'legacy@example.test');assert.equal(smtpMessages[0].subject,legacy.subject);assert.equal(smtpMessages[0].html,legacy.html);assert.equal(smtpMessages[0].text,legacy.text);
        assert.equal((await service.sendTransactionalEmail({type:'password-reset-code',to:'patient@example.test',variables:{code:'004200',ttlMinutes:12}})).success,true);
        assert.match(smtpMessages[1].html,/004200/);assert.match(smtpMessages[1].text,/004200/);assert.equal(typeof smtpMessages[1].subject,'string');
        const noSenders=configure({EMAIL_PROVIDER:'smtp',EMAIL_FROM_AUTH:undefined,EMAIL_FROM_NOTIFICATIONS:undefined});
        assert.equal((await noSenders.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}})).success,true);assert.equal(smtpMessages[0].from,'legacy@example.test');assert.equal(clients.length,0);
        assertNoSecretLogs();
    });
    await check('real mail wrappers preserve reset codes and changed variables while generic mail remains SMTP-only',async()=>{
        configure();let mail=require(mailPath);
        assert.deepEqual(await mail.SendPasswordResetCode('patient@example.test',{code:'004200',ttlMinutes:14}),{process:true});
        assert.equal(input().Content.Template.TemplateName,'Exact-Reset-Template-QA');assert.deepEqual(data(),{code:'004200',ttlMinutes:14,html:{code:'004200',ttlMinutes:'14'}});
        assert.deepEqual(await mail.SendPasswordChanged('patient@example.test'),{process:true});assertSimpleOnly(input());assert.equal(input().Content.Simple.Subject.Data,'Tu contraseña de MedSync fue actualizada');
        const count=commands.length;assert.deepEqual(await mail.SendMail('patient@example.test','<p>Generic body</p>','Generic subject','Generic text'),{process:false});assert.equal(commands.length,count,'Untyped generic mail must not be sent through SES');
        configure({EMAIL_PROVIDER:'smtp'});mail=require(mailPath);
        assert.deepEqual(await mail.SendMail('patient@example.test','<p>Generic body</p>','Generic subject','Generic text'),{process:true});
        assert.equal(smtpMessages[0].subject,'Generic subject');assert.equal(smtpMessages[0].html,'<p>Generic body</p>');assert.equal(smtpMessages[0].text,'Generic text');assert.equal(clients.length,0);assertNoSecretLogs();
    });
    await check('disabled provider remains test-only success, production-disabled failure and unsupported providers stay controlled',async()=>{
        let service=configure({EMAIL_PROVIDER:'disabled'});assert.equal(service.providerName(),'disabled');
        const disabled=await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}});assert.equal(disabled.success,true);assert.equal(disabled.provider,'disabled');assert.equal(clients.length,0);assert.equal(transports.length,0);
        service=configure({EMAIL_PROVIDER:'disabled',NODE_ENV:'production',APP_ENV:'production',ENVIRONMENT:'production'});assertSafeFailure(await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}}),'Disabled production provider');assert.equal(clients.length,0);assert.equal(transports.length,0);
        service=configure({EMAIL_PROVIDER:'unsupported'});assertSafeFailure(await service.sendTransactionalEmail({type:'password-changed',to:'patient@example.test',variables:{}}),'Unsupported provider');assert.equal(clients.length,0);assert.equal(transports.length,0);assertNoSecretLogs();
    });
    assert.ok(envLoads>0,'All real env module imports are intercepted rather than reading dotenv files');
    const failed=results.filter(result=>!result.ok);
    stdout(JSON.stringify({checks:results.length,passed:results.length-failed.length,failed:failed.map(result=>result.name),realSendEmailCommand:true,network:false,database:false,deliveries:0},null,2));
    if(failed.length)process.exitCode=1;
})().catch(error=>{originalConsole.error(error);process.exitCode=1;}).finally(()=>{
    Module._load=originalLoad;
    for(const [name,method] of Object.entries(originalConsole))console[name]=method;
    for(const [key,value] of originalEnv) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
