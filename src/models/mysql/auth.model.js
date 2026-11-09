const {Model, DataTypes} = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');


class Auth extends Model {}

Auth.init({
    id_login: {
        primaryKey: true,
        type: DataTypes.STRING
    },
    first_name: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    last_name: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    email: {
        type: DataTypes.STRING,
        allowNull: false
        // validate: {
        //     notNull: { msg: 'El rol es requerido'},
        //     notEmpty (value) { if(value === '') { throw new Error('El rol es requerido');} }
        // }
    },
    telephone: {
        type: DataTypes.STRING,
        allowNull: false
        // validate: {
        //     notNull: { msg: 'El sistema es requerido'},
        //     notEmpty (value) { if(value === '') { throw new Error('El sistema es requerido');} }
        // }
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
        // validate: {
        //     notNull: { msg: 'El nombre es requerido'},
        //     notEmpty (value) { if(value === '') { throw new Error('El nombre es requerido');} }
        // }
    },
    created_at: {
        type: DataTypes.STRING,
        allowNull: false
        // validate: {
        //     notNull: { msg: 'El codigo es requerido'},
        //     notEmpty (value) { if(value === '') { throw new Error('El codigo es requerido');} }
        // }
    },
    active: {
        type: DataTypes.TINYINT,
    }

}, {
    sequelize, 
    modelName: "login", //Nombre de la tabla en la db
    freezeTableName: true, //forza a que que no cree ls tabls en plural ejemp: cat_systems
});


module.exports = Auth;