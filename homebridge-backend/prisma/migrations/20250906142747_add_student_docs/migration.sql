-- CreateTable
CREATE TABLE "public"."StudentDoc" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT,
    "size" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentDoc_userId_createdAt_idx" ON "public"."StudentDoc"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."StudentDoc" ADD CONSTRAINT "StudentDoc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
