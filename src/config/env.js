const fs = require('fs');
const path = require('path');

function unquote(value) {
  const trimmed = value.trim();

  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];

    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed[0] === '#') {
      return;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      return;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = unquote(line.slice(separatorIndex + 1));

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const rootPath = path.resolve(__dirname, '..', '..');

loadEnvFile(path.join(rootPath, '.env.local'));
loadEnvFile(path.join(rootPath, '.env'));
