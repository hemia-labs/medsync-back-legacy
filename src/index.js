var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var morgan = require('morgan');
const Config = require('./config/config');
const Sequelize = require('./db/Sequelize.connection');
const SecurityConfig = require('./config/security');
const { startSaasTrialLifecycleJob } = require('./jobs/saasTrialLifecycle.job');
const { startBusinessPulseJob } = require('./jobs/businessPulse.job');
const sanitizePublicTokenLogs = require('./middleware/sanitizePublicTokenLogs.middleware');
const noStore = require('./middleware/noStore.middleware');
const { corsCredentialedAllowlist } = require('./middleware/corsCredentialed.middleware');
const { securityHeaders } = require('./middleware/securityHeaders.middleware');

const { defaultBodyParser } = require('./middleware/requestBody.middleware');

const app = express();

app.disable('x-powered-by');

const TRUST_PROXY_OFF_VALUES = ['', 'false', '0', 'off', 'none'];
const TRUST_PROXY_PRESETS = ['loopback', 'linklocal', 'uniquelocal'];

function resolveTrustProxySetting(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (TRUST_PROXY_OFF_VALUES.includes(raw)) {
    return false;
  }

  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const isSafeEntry = (entry) => (
    TRUST_PROXY_PRESETS.includes(entry) ||
    /^[0-9a-f:.\/]+$/i.test(entry)
  );

  if (entries.length > 0 && entries.every(isSafeEntry)) {
    return entries.join(', ');
  }

  console.warn('[SECURITY CONFIG] EXPRESS_TRUST_PROXY ignored. Use false, a hop count like 1, a trusted proxy preset, or explicit subnet(s).');
  return false;
}

const trustProxySetting = resolveTrustProxySetting(process.env.EXPRESS_TRUST_PROXY);
if (trustProxySetting !== false) {
  app.set('trust proxy', trustProxySetting);
}

SecurityConfig.validateStartupConfig();
const emailStartup = require('./services/email/email.service').initialize();
if (!emailStartup.success) console.warn('[EMAIL CONFIG]', { code: emailStartup.code, message: emailStartup.message });
app.set('etag', false);

//server port
app.set('port', process.env.PORT || Config.PORT);


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);

app.use(sanitizePublicTokenLogs);
morgan.token('safe-url', (req) => req.sanitizedUrlForLogs || sanitizePublicTokenLogs.sanitizePublicSignatureToken(req.originalUrl || req.url || ''));
app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
app.use(cookieParser());
app.use(securityHeaders());
app.use(express.static(path.join(__dirname, 'public')));
app.use(corsCredentialedAllowlist());
app.use('/api', noStore);
app.use(defaultBodyParser);
app.use('/api', require('./middleware/pulseInvalidation.middleware').pulseInvalidation);


//routes
app.use(require('../src/routes/index'));

//Api
app.use('/api/auth', require('./routes/mysql/auth'));
app.use('/api/rol', require('./routes/mysql/rol'));
app.use('/api/user', require('./routes/mysql/user'));
app.use('/api/home', require('./routes/mysql/home'));
app.use('/api/px', require('./routes/mysql/px'));
app.use('/api/catalog', require('./routes/mysql/catalog'));
app.use('/api/file', require('./routes/mysql/file'));
app.use('/api/tracing', require('./routes/mysql/tracing'));
app.use('/api/treatment', require('./routes/mysql/treatment'));
app.use('/api/teeth', require('./routes/mysql/teeth'));
app.use('/api/odontogram', require('./routes/mysql/odontogram'));
app.use('/api/config', require('./routes/mysql/config'));
app.use('/api/appointment', require('./routes/mysql/appointment'));
app.use('/api/business/dashboard', require('./routes/mysql/business-dashboard'));
app.use('/api/business/pulse', require('./routes/mysql/business-pulse'));
app.use('/api/business', require('./routes/mysql/business'));
app.use('/api/saas-legal', require('./routes/mysql/saas-legal'));
app.use('/api/super-admin/saas-legal', require('./routes/mysql/super-admin-saas-legal'));
app.use('/api/super-admin', require('./routes/mysql/super-admin'));
app.use('/api/prescription', require('./routes/mysql/prescription'));
app.use('/api/document', require('./routes/mysql/document'));
app.use('/api/public/document-signature', require('./routes/mysql/public-document-signature'));
app.use('/api/clinical-history', require('./routes/mysql/clinical-history'));
app.use('/api/clinical-history-template', require('./routes/mysql/clinical-history-template'));

// app.use('/api/category', require('./routes/mysql/category'));
// app.use('/api/productService', require('./routes/mysql/productService'));


// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

app.listen(app.get('port'), () => {
  console.log("server runing in: "+ app.get('port'));
  Sequelize.sync({force: false}).then(() => {
    console.log("Autenticacion correcta a mysql");
    startSaasTrialLifecycleJob();
    startBusinessPulseJob();
    require('./services/pulse/runtime').startMetricsLogging();
  }).catch(error => {console.log("Error a conectar mysql", error);});
});


module.exports = app;
