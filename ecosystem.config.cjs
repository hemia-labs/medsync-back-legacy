// PM2 process definition for medsync-back-legacy.
//
// IMPORTANT: fork mode + a single instance only. Do NOT use cluster:
//   - src/index.js arranca un cron en memoria (startSaasTrialLifecycleJob),
//     que se duplicaría por cada worker.
//   - express-session y node-localstorage usan estado en memoria/disco local
//     que no se comparte entre workers.
//
// cwd se fija a __dirname (raíz del release) porque src/util/file/file.js usa
// rutas RELATIVAS al CWD ('src/tempFolder/...'). Si PM2 arranca con otro CWD,
// la subida de archivos rompe.

module.exports = {
  apps: [
    {
      name: 'medsync-back-legacy',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '600M',
      watch: false,
      // La app carga .env / .env.local por su cuenta (src/config/env.js),
      // pero fijamos NODE_ENV aquí para garantizar el modo producción.
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
