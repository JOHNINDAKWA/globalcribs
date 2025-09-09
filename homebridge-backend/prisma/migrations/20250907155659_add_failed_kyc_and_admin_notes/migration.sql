-- AlterEnum
ALTER TYPE "public"."StudentKycStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "public"."StudentProfile" ADD COLUMN     "adminNotes" TEXT;
