-- Subscription: unique Stripe ids
CREATE UNIQUE INDEX "Subscription_stripeCustomerId_key" ON "Subscription"("stripeCustomerId");
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- WebhookDelivery: single error column, bounded text
UPDATE "WebhookDelivery" SET "errorMessage" = COALESCE("errorMessage", "lastError") WHERE "lastError" IS NOT NULL;
ALTER TABLE "WebhookDelivery" DROP COLUMN "lastError";
UPDATE "WebhookDelivery" SET "payload" = LEFT("payload", 65536), "responseBody" = LEFT("responseBody", 1000), "errorMessage" = LEFT("errorMessage", 1000);
ALTER TABLE "WebhookDelivery" ALTER COLUMN "payload" TYPE VARCHAR(65536),
  ALTER COLUMN "errorMessage" TYPE VARCHAR(1000),
  ALTER COLUMN "responseBody" TYPE VARCHAR(1000);

-- Post: author, external id, timestamps
ALTER TABLE "Post" ADD COLUMN "authorId" TEXT,
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Post_platform_externalId_idx" ON "Post"("platform", "externalId");

-- AnalyticsEntry: natural unique key (drop existing duplicates first)
DELETE FROM "AnalyticsEntry" a USING "AnalyticsEntry" b
  WHERE a."organizationId" = b."organizationId" AND a."platform" = b."platform"
    AND a."metric" = b."metric" AND a."recordedAt" = b."recordedAt" AND a."id" > b."id";
CREATE UNIQUE INDEX "AnalyticsEntry_organizationId_platform_metric_recordedAt_key"
  ON "AnalyticsEntry"("organizationId", "platform", "metric", "recordedAt");
