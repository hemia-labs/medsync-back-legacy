

const date = new Date();

function _getDate(type = 'ymd'){
;
    let _date = date.getDate() < 10 ? ('0'+date.getDate().toString()) : date.getDate();
    let _month = (date.getMonth() + 1) < 10 ? '0'+(date.getMonth() + 1).toString() : (date.getMonth() + 1).toString();
    let _year = date.getFullYear().toString();

    let obj = _year + '-' + _month + '-' + _date;
    if(type == 'dmy') obj = _date + '-' + _month + '-' + _year;
    return obj;
}

/**
 * Date in Format YYYY-MM-DDThh-mm-ss
 * @returns 2011-10-05T14:48:00.000Z
 */
function datetoISOString(){
    return date.toISOString();
}

/**
 * Date in Format YYYY-MM-DD
 * @returns 2011-10-05
 */
function dateYMD(){
    return _getDate();
}

/**
 * Date in Format DD-MM-YYYY
 * @returns 05-11-2011
 */
function dateDMY(){
    return _getDate('dmy');
}

module.exports = {
    datetoISOString,
    dateYMD,
    dateDMY
}