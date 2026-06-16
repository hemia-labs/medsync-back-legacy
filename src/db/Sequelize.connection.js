const config = require('../config/config');
var Sequelize = require('sequelize');

const database = new Sequelize(
  config.DATABASEMYSQL, // name database
  config.USERMYSQL, // user database
  config.PASSWORDMYSQL, // password database
  {
    host: config.HOSTMYSQL,
    port: config.PORTMYSQL,
    dialect: 'mysql', // mariadb / sqlite / postgres
    logging: process.env.SQL_LOGGING === 'true' ? console.log : false
  }
);


module.exports = database;
