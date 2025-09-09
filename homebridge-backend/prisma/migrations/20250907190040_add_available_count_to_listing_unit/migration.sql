/*
  Warnings:

  - You are about to drop the column `createdAt` on the `ListingUnit` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."ListingUnit" DROP COLUMN "createdAt",
ADD COLUMN     "availableCount" INTEGER DEFAULT 0;

-- CreateIndex
CREATE INDEX "ListingUnit_listingId_idx" ON "public"."ListingUnit"("listingId");
