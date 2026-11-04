ALTER TABLE "profiles"
ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN "notification_preferences" JSONB NOT NULL DEFAULT '{}'::jsonb;