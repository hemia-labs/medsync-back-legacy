const {Model, DataTypes} = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');


class Rol extends Model {}

Rol.init({
    id_rol: {
        primaryKey: true,
        type: DataTypes.STRING
    },
    desc_rol: {
        type: DataTypes.STRING,
        allowNull: false
    },
    code: {
        type: DataTypes.STRING,
        allowNull: false
    },
    active: {
        type: DataTypes.TINYINT,
    }

}, {
    sequelize, 
    modelName: "rol", //Nombre de la tabla en la db
    freezeTableName: true, //forza a que que no cree ls tabls en plural ejemp: cat_systems
});


module.exports = Rol;