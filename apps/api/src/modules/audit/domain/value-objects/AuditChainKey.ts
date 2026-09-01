import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';
import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';

const PLATFORM_CHAIN_KEY = 'PLATFORM';

interface AuditChainKeyProps {
  readonly value: string;
}

/**
 * Perimetre d'une chaine de chainage SHA-256 (ADR-0009 §5.1) : un tenant, ou la plateforme — et
 * non une chaine globale unique (alternative ecartee #6). Miroir applicatif de la colonne
 * generee `chain_key` (`GENERATED ALWAYS AS (COALESCE(tenant_id::text, 'PLATFORM')) STORED`) :
 * ce Value Object DOIT calculer exactement la meme valeur, jamais une approximation, car elle
 * entre dans la charge canonique hachee (§5.2).
 */
export class AuditChainKey extends ValueObject<AuditChainKeyProps> {
  private constructor(props: AuditChainKeyProps) {
    super(props);
  }

  static forTenant(tenantId: TenantId): AuditChainKey {
    return new AuditChainKey({ value: tenantId.toString() });
  }

  static platform(): AuditChainKey {
    return new AuditChainKey({ value: PLATFORM_CHAIN_KEY });
  }

  /** Derive la chaine depuis un `tenantId` NULLABLE (miroir exact de `COALESCE(tenant_id::text, 'PLATFORM')`). */
  static derive(tenantId: string | null): AuditChainKey {
    return new AuditChainKey({ value: tenantId ?? PLATFORM_CHAIN_KEY });
  }

  override toString(): string {
    return this.props.value;
  }
}
