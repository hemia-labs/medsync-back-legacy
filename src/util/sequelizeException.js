const responseData = require('../util/responsedata');
const {ValidationError, DatabaseError} =  require('sequelize');
const Messages = require('../util/common.messages.util');
const {throwModelException} = require('../util/throw.model.exception');

/**
 * codigo de excepciones emitidas por el manejador [https://mariadb.com/kb/en/mariadb-error-codes/]
 */
const ArraySQlCodeException = [
  1100,1101,1102,1103,1104,1105,
  1106,1107,1108,1109,1110,1111,
  1112,1113,1114,1115,1116,1117,
  1118,1119,1120,1121,1122,1123,
  1124,1125,1126,1127,1128,1129,
  1130,1131,1132,1133,1134,1135,
  1136,1137,1138,1139,1140,1141,
  1142,1143,1144,1145,1146,1147,
  1148,1149,1150,1151,1152,1153,
  1154,1155,1156,1157,1158,1159,
  1160,1161,1162,1163,1164,1165,
  1166,1167,1168,1169,1170,1171,
  1172,1173,1174,1175,1176,1177,
  1178,1179,1180,1181,1182,1183,
  1184,1185,1186,1187,1188,1189,
  1190,1191,1192,1193,1194,1195,
  1196,1197,1198,1199,
  1600,1601,1602,1603,1604,1605,
  1606,1607,1608,1609,1610,1611,
  1612,1613,1614,1615,1616,1617,
  1618,1619,1620,1621,1622,1623,
  1624,1625,1626,1627,1628,1629,
  1630,1631,1632,1633,1634,1635,
  1636,1637,1638,1639,1640,1641,
  1642,1643,1644,1645,1646,1647,
  1648,1649,1650,1651,1652,1653,
  1654,1655,1656,1657,1658,1659,
  1660,1661,1662,1663,1664,1665,
  1666,1668,1669,1670,1671,1672,
  1673,1674,1675,1676,1677,1678,
  1679,1680,1681,1682,1683,1684,
  1685,1686,1687,1688,1689,1690,
  1691,1692,1693,1694,1695,1696,
  1697,1698,1699,1048,1054,1242
];


/**
 * Función que permite analizar y destructurar la lista de errores en sequelize
 * @param {any} error Error producido por la excepcion en sequelize
 * @returns Response Data Errors
 */
    function SequelizeException(error, message = Messages.INTERNAL_ERROR)  {
        let response = responseData.error(error.message);
        if(error instanceof ValidationError) {
            response =  responseData.bad_request(message, throwModelException(error.errors));;
          }else if (error instanceof DatabaseError){
            response =  responseData.bad_request(error.message);
          }else {
              response = responseData.error(error.message);
          }
        return response;
    }

     /**
     * Función que permite validar si hay un error en la respuesta de MYSQL
     * @param {any} data Datos del SQL
     * @returns 
     */
      function SQLException(data) {

        let exception = {hasError: false, message: ''};

        let Code = (data[0] && data[0].Code ? data[0].Code :  0);

        if(Code>0){
          if( ArraySQlCodeException.includes(Code) ){
              exception.hasError = true;
              exception.message = data[0].Message;            
          }
        }

         return exception;
      }
  
module.exports = {
    SequelizeException,
    SQLException
};