'use strict';

const http = require('http');
const express = require('express');
const { securityHeaders } = require('../../src/middleware/securityHeaders.middleware');

function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/qa/security-headers',
      method: 'GET',
      headers: headers || {}
    }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function headerIncludes(headers, name, value) {
  const actual = headers[String(name).toLowerCase()];
  return typeof actual === 'string' && actual.indexOf(value) >= 0;
}

function assert(condition, name, evidence) {
  return {
    name,
    ok: Boolean(condition),
    evidence: evidence || null
  };
}

async function withEnv(env, fn) {
  const previous = {};
  Object.keys(env).forEach((key) => {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  });

  try {
    return await fn();
  } finally {
    Object.keys(env).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

async function runScenario(env, options) {
  return withEnv(env, async () => {
    const app = express();
    if (options && options.trustProxy) {
      app.set('trust proxy', 1);
    }
    app.use(securityHeaders());
    app.get('/api/qa/security-headers', (req, res) => {
      res.status(204).end();
    });

    const server = await listen(app);
    try {
      const address = server.address();
      return await request(address.port, options && options.headers);
    } finally {
      await close(server);
    }
  });
}

async function run() {
  const localResponse = await runScenario({
    NODE_ENV: 'development',
    SECURITY_CSP_REPORT_ONLY: 'true'
  });
  const stagingHttpsResponse = await runScenario({
    NODE_ENV: 'staging',
    SECURITY_CSP_REPORT_ONLY: 'true'
  }, {
    trustProxy: true,
    headers: {
      'X-Forwarded-Proto': 'https'
    }
  });
  const stagingHttpResponse = await runScenario({
    NODE_ENV: 'staging',
    SECURITY_CSP_REPORT_ONLY: 'true'
  });

  const checks = [
    assert(localResponse.statusCode === 204, 'real HTTP response is served', {
      statusCode: localResponse.statusCode
    }),
    assert(headerIncludes(localResponse.headers, 'content-security-policy-report-only', "frame-ancestors 'self'"), 'CSP report-only includes frame-ancestors', {
      header: localResponse.headers['content-security-policy-report-only']
    }),
    assert(localResponse.headers['x-frame-options'] === 'SAMEORIGIN', 'X-Frame-Options is present', {
      header: localResponse.headers['x-frame-options']
    }),
    assert(headerIncludes(localResponse.headers, 'permissions-policy', 'camera=()'), 'Permissions-Policy is present', {
      header: localResponse.headers['permissions-policy']
    }),
    assert(!localResponse.headers['strict-transport-security'], 'HSTS is absent on local HTTP', {
      header: localResponse.headers['strict-transport-security'] || null
    }),
    assert(headerIncludes(stagingHttpsResponse.headers, 'strict-transport-security', 'max-age='), 'HSTS is present on staging/prod HTTPS', {
      header: stagingHttpsResponse.headers['strict-transport-security']
    }),
    assert(!stagingHttpResponse.headers['strict-transport-security'], 'HSTS is absent on staging plain HTTP', {
      header: stagingHttpResponse.headers['strict-transport-security'] || null
    })
  ];

  const result = {
    ok: checks.every((item) => item.ok),
    script: 'security-headers-http-regression',
    checks
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
