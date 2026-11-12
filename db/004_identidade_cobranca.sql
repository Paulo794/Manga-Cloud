-- Identidade durável independente do ID numérico, que pode se repetir em outros bancos.
-- DDL retomável após falha parcial do runner; não altera migrações já aplicadas.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS billing_identity CHAR(36) DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_usuarios_billing_identity ON usuarios (billing_identity);
