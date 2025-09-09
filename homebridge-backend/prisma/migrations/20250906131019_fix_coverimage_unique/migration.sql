-- CreateEnum
CREATE TYPE "public"."BookingStatus" AS ENUM ('PENDING_PAYMENT', 'PAYMENT_COMPLETE', 'READY_TO_SUBMIT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."BookingPayMethod" AS ENUM ('CARD', 'MPESA');

-- CreateTable
CREATE TABLE "public"."Booking" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "checkIn" TEXT NOT NULL,
    "checkOut" TEXT NOT NULL,
    "note" TEXT,
    "docIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "docsUpdatedAt" TIMESTAMP(3),
    "applicationFeeCents" INTEGER NOT NULL DEFAULT 2500,
    "paymentMethod" "public"."BookingPayMethod",
    "feePaidAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "status" "public"."BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_studentId_createdAt_idx" ON "public"."Booking"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_listingId_createdAt_idx" ON "public"."Booking"("listingId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."Booking" ADD CONSTRAINT "Booking_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Booking" ADD CONSTRAINT "Booking_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
