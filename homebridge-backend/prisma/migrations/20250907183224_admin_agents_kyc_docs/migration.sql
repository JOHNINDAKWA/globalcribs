-- CreateEnum
CREATE TYPE "public"."AgentKycStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED');

-- AlterTable
ALTER TABLE "public"."AgentProfile" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "kycStatus" "public"."AgentKycStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "rating" DOUBLE PRECISION DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."AgentDoc" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT,
    "size" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDoc_userId_createdAt_idx" ON "public"."AgentDoc"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."AgentDoc" ADD CONSTRAINT "AgentDoc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
