-- Rename "mode" column to "chat_mode" to avoid PostgreSQL conflict
-- with the built-in mode() ordered-set aggregate function.
-- Idempotent: safe to re-run if previous attempt partially succeeded.

DO $$
BEGIN
  -- Rename column only if old name still exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name = 'mode'
  ) THEN
    ALTER TABLE "Conversation" RENAME COLUMN "mode" TO "chat_mode";
  END IF;

  -- Recreate index with new column name (drop old if exists)
  DROP INDEX IF EXISTS "Conversation_creatorId_mode_idx";
  DROP INDEX IF EXISTS "Conversation_creatorId_chat_mode_idx";
  CREATE INDEX "Conversation_creatorId_chat_mode_idx" ON "Conversation"("creatorId", "chat_mode");
END $$;
