-- CreateEnum
CREATE TYPE "public"."AdminScope" AS ENUM ('SUPERADMIN', 'ADMIN', 'ANALYST', 'READONLY');

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "adminScope" "public"."AdminScope",
ADD COLUMN     "apiKey" TEXT,
ADD COLUMN     "invitedAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "twoFA" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "public"."User"("role", "status");
