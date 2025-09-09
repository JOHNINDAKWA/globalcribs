-- CreateEnum
CREATE TYPE "public"."StudentKycStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "public"."PayoutMethod" AS ENUM ('BANK', 'MPESA');

-- CreateEnum
CREATE TYPE "public"."UnitPref" AS ENUM ('IMPERIAL', 'METRIC');

-- CreateTable
CREATE TABLE "public"."StudentProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "dob" TEXT,
    "nationality" TEXT,
    "passportNo" TEXT,
    "school" TEXT,
    "program" TEXT,
    "intake" TEXT,
    "targetCity" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "addressCity" TEXT,
    "addressCountry" TEXT,
    "postal" TEXT,
    "emergencyName" TEXT,
    "emergencyRelation" TEXT,
    "emergencyPhone" TEXT,
    "commsEmail" BOOLEAN DEFAULT false,
    "commsSMS" BOOLEAN DEFAULT false,
    "commsWhatsApp" BOOLEAN DEFAULT false,
    "kycStatus" "public"."StudentKycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "paymentMethods" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "first" TEXT,
    "last" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "orgName" TEXT,
    "website" TEXT,
    "supportEmail" TEXT,
    "payoutMethod" "public"."PayoutMethod" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "branch" TEXT,
    "mpesaPhone" TEXT,
    "prefsTimezone" TEXT DEFAULT 'Africa/Nairobi',
    "prefsCurrency" TEXT DEFAULT 'USD',
    "prefsUnit" "public"."UnitPref" NOT NULL DEFAULT 'IMPERIAL',
    "notifyNewInquiry" BOOLEAN DEFAULT true,
    "notifyDocUploaded" BOOLEAN DEFAULT true,
    "notifyOfferEmailed" BOOLEAN DEFAULT true,
    "notifyPayoutPaid" BOOLEAN DEFAULT true,
    "notifyWeeklyDigest" BOOLEAN DEFAULT false,
    "devWebhook" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_userId_key" ON "public"."StudentProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_userId_key" ON "public"."AgentProfile"("userId");

-- AddForeignKey
ALTER TABLE "public"."StudentProfile" ADD CONSTRAINT "StudentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentProfile" ADD CONSTRAINT "AgentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
