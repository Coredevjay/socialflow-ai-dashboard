-- #1793: drop indexes duplicated by @unique
DROP INDEX IF EXISTS "User_email_idx";
DROP INDEX IF EXISTS "Organization_slug_idx";
DROP INDEX IF EXISTS "PayoutTransaction_transactionHash_idx";
DROP INDEX IF EXISTS "Subscription_userId_idx";

-- #1792: exact decimal amounts (Stellar precision)
ALTER TABLE "Listing" ALTER COLUMN "price" TYPE DECIMAL(20,7) USING "price"::numeric;
ALTER TABLE "PayoutTransaction" ALTER COLUMN "amount" TYPE DECIMAL(20,7) USING "amount"::numeric;
ALTER TABLE "PayoutFailure" ALTER COLUMN "amount" TYPE DECIMAL(20,7) USING "amount"::numeric;

-- #1794: enums
CREATE TYPE "PostPlatform" AS ENUM ('instagram', 'tiktok', 'facebook', 'youtube', 'linkedin', 'twitter', 'x');
CREATE TYPE "ModerationStatus" AS ENUM ('pending', 'approved', 'rejected', 'flagged');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'success', 'failed');
CREATE TYPE "TTSJobStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'submitted', 'confirmed', 'failed');
CREATE TYPE "SubscriptionPlan" AS ENUM ('free', 'starter', 'pro', 'enterprise');
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'canceled', 'past_due', 'trialing');

ALTER TABLE "Post" ALTER COLUMN "platform" TYPE "PostPlatform" USING "platform"::"PostPlatform";
ALTER TABLE "Post" ALTER COLUMN "moderationStatus" DROP DEFAULT;
ALTER TABLE "Post" ALTER COLUMN "moderationStatus" TYPE "ModerationStatus" USING "moderationStatus"::"ModerationStatus";
ALTER TABLE "Post" ALTER COLUMN "moderationStatus" SET DEFAULT 'pending';

ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" TYPE "WebhookDeliveryStatus" USING "status"::"WebhookDeliveryStatus";
ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "TTSJob" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "TTSJob" ALTER COLUMN "status" TYPE "TTSJobStatus" USING "status"::"TTSJobStatus";
ALTER TABLE "TTSJob" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "PayoutTransaction" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PayoutTransaction" ALTER COLUMN "status" TYPE "PayoutStatus" USING "status"::"PayoutStatus";
ALTER TABLE "PayoutTransaction" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "Subscription" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "Subscription" ALTER COLUMN "plan" TYPE "SubscriptionPlan" USING "plan"::"SubscriptionPlan";
ALTER TABLE "Subscription" ALTER COLUMN "plan" SET DEFAULT 'free';
ALTER TABLE "Subscription" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Subscription" ALTER COLUMN "status" TYPE "SubscriptionStatus" USING "status"::"SubscriptionStatus";
ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'active';
