const router = require('express').Router();
const Token = require('../../auth/authenticate');
const requireTenantOperational = require('../../middleware/requireTenantOperational.middleware');
const awaitHandlerFactory = require('../../middleware/awaitHandlerFactory.middleware');
const CatalogController = require('../../controller/mysql/catalog.controller');

router.get('/Pathological', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getCatalogPathological));

router.get('/SectionsPathological', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getCatalogSectionsPathological));

router.get('/Files', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getCatalogFiles));

router.get('/treatment', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getTreatment));

router.get('/teeth/condition', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getConditions));

router.get('/v0/cat-unit', Token.Auth, requireTenantOperational, awaitHandlerFactory(CatalogController.getCatUnit));

module.exports = router; 