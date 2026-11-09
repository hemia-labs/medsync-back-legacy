require('./env');

module.exports = {

    //mongodb
    SERVER: process.env.SERVER || '',
    PORT: process.env.PORT || 3009,
    USER: process.env.DB_USER || '',
    PASSWORD: process.env.DB_PASSWORD || '',
    DATABASE: process.env.DB_NAME || '',
    IP: process.env.DB_HOST || '',

    /**
     * 
     */

    //Mysql
    HOSTMYSQL : process.env.DB_HOST || '',
    USERMYSQL : process.env.DB_USER || '',
    PASSWORDMYSQL : process.env.DB_PASSWORD || '',
    DATABASEMYSQL : process.env.DB_NAME || '',
    PORTMYSQL : Number(process.env.DB_PORT || 3306),

    SESSIONSECRET : process.env.SESSION_SECRET || '',

    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',

    USERGMAIL : process.env.MAIL_USER || '',
    PASSWORDGMAIL : process.env.MAIL_PASSWORD || '',
    SERVICEMAIL : process.env.MAIL_SERVICE || '',

    VUE_APP_FIREBASE_FCM_KEY: process.env.FIREBASE_FCM_KEY || '',
    
    //s3
    AWS_REGION : process.env.AWS_REGION || '',
    AWS_ACCESS_KEY : process.env.AWS_ACCESS_KEY_ID || '',
    AWS_SECRET_KEY : process.env.AWS_SECRET_ACCESS_KEY || '',
    S3_PRIVATE_BUCKET: process.env.S3_PRIVATE_BUCKET || '',

    /**Repositorios ya existentes en el AWS S3 */
    BUCKETS:{
         FIRMAS : process.env.AWS_BUCKET_FIRMAS || '' ,
         PHOTOS : process.env.AWS_BUCKET_PHOTOS || '',
         XRAY : process.env.AWS_BUCKET_XRAY || '',
         PROFILE : process.env.AWS_BUCKET_PROFILE || '',
         CONFIGFIRMS : process.env.AWS_BUCKET_CONFIG_FIRMS || ''
    }

}
