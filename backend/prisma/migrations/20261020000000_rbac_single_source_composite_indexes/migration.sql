-- Backfill RoleAssignment from the legacy User.role before dropping it
INSERT INTO "RoleAssignment" ("id", "userId", "role", "updatedAt")
SELECT gen_random_uuid()::text, u."id", u."role", NOW() FROM "User" u
WHERE u."role" IN ('admin', 'editor', 'viewer')
ON CONFLICT ("userId") DO NOTHING;

ALTER TABLE "User" DROP COLUMN "role";

CREATE INDEX "Post_organizationId_scheduledAt_idx" ON "Post"("organizationId", "scheduledAt");
CREATE INDEX "Post_organizationId_createdAt_idx" ON "Post"("organizationId", "createdAt");
CREATE INDEX "AnalyticsEntry_organizationId_platform_metric_recordedAt_idx" ON "AnalyticsEntry"("organizationId", "platform", "metric", "recordedAt");
