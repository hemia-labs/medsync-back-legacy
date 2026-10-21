-- Explicit destructive rollback, synthetic QA only in P2. Never executed at startup.
-- Refuse to remove catalog permission if an operator has granted it since migration.
-- QA runner verifies zero references before issuing these statements.
DELETE FROM cat_permission WHERE code='pulse.view.business'
 AND NOT EXISTS(SELECT 1 FROM permission_rol p WHERE p.id_cat_permission=cat_permission.id_cat_permission)
 AND NOT EXISTS(SELECT 1 FROM business_role_permission b WHERE b.id_cat_permission=cat_permission.id_cat_permission);
DROP TABLE IF EXISTS business_pulse_captures;
