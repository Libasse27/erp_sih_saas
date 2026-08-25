import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPlatformInvoiceIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de facture plateforme invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidPlatformInvoiceIdError';
  }
}

interface PlatformInvoiceIdProps {
  readonly value: string;
}

/** Identifiant d'une `PlatformInvoice` (voir domain/PlatformInvoice.ts). */
export class PlatformInvoiceId extends ValueObject<PlatformInvoiceIdProps> {
  private constructor(props: PlatformInvoiceIdProps) {
    super(props);
  }

  static create(value: string): Result<PlatformInvoiceId, InvalidPlatformInvoiceIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidPlatformInvoiceIdError(value));
    }
    return Result.success(new PlatformInvoiceId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
