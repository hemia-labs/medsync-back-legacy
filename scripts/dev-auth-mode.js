'use strict';

const { spawn } = require('child_process');

const FRONTEND_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:8082',
  'http://127.0.0.1:8082',
  'http://localhost:8098',
  'http://127.0.0.1:8098'
].join(',');

const mode = String(process.argv[2] || 'd2').trim().toLowerCase();

if (mode !== 'd2' && mode !== 'legacy') {
  console.error('[local-dev] Usage: node scripts/dev-auth-mode.js d2|legacy');
  process.exit(1);
}

const baseEnv = Object.assign({}, process.env, {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  ENVIRONMENT: 'development',
  PORT: process.env.PORT || '3009',
  REQUIRE_ACTIVE_SESSION: 'true'
});

const d2Env = Object.assign({}, baseEnv, {
  AUTH_COOKIE_MODE: 'd2',
  BROWSER_AUTH_TRANSPORT: 'cookie',
  AUTH_COOKIE_ACCESS_NAME: 'medsync_at_dev',
  AUTH_COOKIE_REFRESH_NAME: 'medsync_rt_dev',
  AUTH_CSRF_COOKIE_NAME: 'medsync_csrf_dev',
  CSRF_COOKIE_NAME: 'medsync_csrf_dev',
  AUTH_COOKIE_SECURE: 'false',
  AUTH_COOKIE_SAMESITE: 'lax',
  AUTH_COOKIE_DOMAIN: '',
  AUTH_COOKIE_PATH: '/',
  AUTH_COOKIE_MAX_AGE_MODE: 'session',
  CSRF_ENABLED: 'true',
  CSRF_ORIGIN_CHECK_ENABLED: 'true',
  CSRF_ALLOWED_ORIGINS: FRONTEND_ORIGINS,
  CORS_CREDENTIALS: 'true',
  CORS_ALLOWED_ORIGINS: FRONTEND_ORIGINS,
  CORS_ORIGIN: FRONTEND_ORIGINS
});

const legacyEnv = Object.assign({}, baseEnv, {
  AUTH_COOKIE_MODE: 'legacy',
  BROWSER_AUTH_TRANSPORT: 'authorization',
  CSRF_ENABLED: 'false',
  CSRF_ORIGIN_CHECK_ENABLED: 'false',
  CORS_CREDENTIALS: 'false',
  CORS_ALLOWED_ORIGINS: FRONTEND_ORIGINS,
  CORS_ORIGIN: FRONTEND_ORIGINS
});

const env = mode === 'legacy' ? legacyEnv : d2Env;
const summary = mode === 'legacy'
  ? 'legacy Authorization transport'
  : 'D2 cookie transport';

console.log(`[local-dev] Starting backend ${summary} on http://127.0.0.1:${env.PORT}`);

const child = spawn('nodemon', ['src/index.js'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
});

child.on('error', (error) => {
  console.error(`[local-dev] Failed to start nodemon: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code === null ? 1 : code);
});
