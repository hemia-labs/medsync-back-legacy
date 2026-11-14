'use strict';
// Only internally constructed messages are safe to print; never log driver SQL/messages/config.
class InstallationError extends Error {}
function safeCause(error) {
 if(error instanceof InstallationError)return {message:error.message};
 const cause={};
 if(/^ER_[A-Z0-9_]{1,64}$/.test(error && error.code || '') || ['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','ECONNRESET'].includes(error && error.code))cause.code=error.code;
 if(/^[A-Z0-9]{5}$/.test(error && error.sqlState || ''))cause.sqlState=error.sqlState;
 return Object.keys(cause).length?cause:{message:'Unexpected installation error; inspect the target schema and audit through the approved operator procedure.'};
}
module.exports={InstallationError,safeCause};
