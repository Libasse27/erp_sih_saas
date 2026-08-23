import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidPermissionError extends Error {
  constructor(value: string) {
    super(
      `Permission invalide : "${value}" (format attendu : "<ressource>:<action>", ` +
        'kebab-case, ex. "patient:read").',
    );
    this.name = 'InvalidPermissionError';
  }
}

interface PermissionProps {
  readonly resource: string;
  readonly action: string;
}

const SEGMENT_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Ressources dont les permissions ne peuvent JAMAIS etre attribuees a un role personnalise
 * de tenant (regle 01-target-architecture.md §7.2 : "le catalogue de permissions est de
 * niveau plateforme ; les roles sont de niveau tenant" + decision explicite de cette etape :
 * un role personnalise ne peut jamais s'attribuer une permission de niveau plateforme).
 *
 * Choix conservateur documente : le cahier des charges ne fournit pas de liste exhaustive de
 * ressources "plateforme" — cette liste est deduite des agregats explicitement qualifies de
 * "niveau plateforme" en §6.3 (Tenant, Plan, Subscription, PlatformInvoice, Payment SaaS,
 * DiscountCoupon, audit plateforme, gestion des identites globales). A faire valider par
 * l'architecte si un module ulterieur introduit une ressource plateforme non listee ici.
 */
export const PLATFORM_ONLY_RESOURCES: ReadonlySet<string> = new Set([
  'tenant',
  'subscription',
  'plan',
  'plan-price',
  'platform-invoice',
  'saas-payment',
  'discount-coupon',
  'platform-audit',
  'user-account',
]);

/**
 * Permission RBAC au format `<ressource>:<action>` (01-target-architecture.md §7.2). Le
 * catalogue de permissions est une donnee de niveau plateforme (source de verite unique) ;
 * ce VO ne fait qu'exprimer et valider la forme d'un code de permission, il ne porte pas le
 * catalogue lui-meme (voir `services/SystemRoleCatalog.ts`).
 */
export class Permission extends ValueObject<PermissionProps> {
  private constructor(props: PermissionProps) {
    super(props);
  }

  static create(code: string): Result<Permission, InvalidPermissionError> {
    const parts = code.split(':');
    if (parts.length !== 2) {
      return Result.failure(new InvalidPermissionError(code));
    }
    const [resource, action] = parts;
    if (
      resource === undefined ||
      action === undefined ||
      !SEGMENT_PATTERN.test(resource) ||
      !SEGMENT_PATTERN.test(action)
    ) {
      return Result.failure(new InvalidPermissionError(code));
    }
    return Result.success(new Permission({ resource, action }));
  }

  get resource(): string {
    return this.props.resource;
  }

  get action(): string {
    return this.props.action;
  }

  get code(): string {
    return `${this.props.resource}:${this.props.action}`;
  }

  isPlatformOnly(): boolean {
    return PLATFORM_ONLY_RESOURCES.has(this.props.resource);
  }

  override toString(): string {
    return this.code;
  }
}
