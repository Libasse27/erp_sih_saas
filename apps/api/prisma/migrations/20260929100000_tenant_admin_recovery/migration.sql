-- Récupération d'accès à un tenant sans administrateur, sous contrôle de deux SUPER_ADMIN
-- distincts. La vérification d'identité par deux autres SUPER_ADMIN est hors bande et reste une
-- condition opérationnelle distincte (docs/architecture/03-open-decisions.md).
-- Table platform sans FK : conserver la trace même si le compte bénéficiaire ou le tenant change.

CREATE TYPE "platform"."TenantAdminRecoveryRequestStatus" AS ENUM ('PENDING', 'APPROVED');

CREATE TABLE "platform"."TenantAdminRecoveryRequest" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "beneficiary_user_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "platform"."TenantAdminRecoveryRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_user_id" UUID,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "TenantAdminRecoveryRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TenantAdminRecoveryRequest_tenant_id_status_idx"
    ON "platform"."TenantAdminRecoveryRequest"("tenant_id", "status");
CREATE INDEX "TenantAdminRecoveryRequest_beneficiary_user_id_idx"
    ON "platform"."TenantAdminRecoveryRequest"("beneficiary_user_id");

-- L'événement MEMBERSHIP_GRANTED existant reste la preuve de la mutation du membership ; ces
-- événements distincts tracent la demande et l'approbation plateforme elles-mêmes.
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'TENANT_ADMIN_RECOVERY_REQUESTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'TENANT_ADMIN_RECOVERY_APPROVED';
