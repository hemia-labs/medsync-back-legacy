const SecurityConfig = require('./security');

module.exports ={
        key : process.env.JWT_SECRET || SecurityConfig.DEFAULT_JWT_SECRET,
        expiresIn : {expiresIn: SecurityConfig.getJwtExpiresIn()}
    }
