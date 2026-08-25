import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPaymentIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de paiement invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidPaymentIdError';
  }
}

interface PaymentIdProps {
  readonly value: string;
}

/** Identifiant d'un `Payment` (tentative de paiement — voir domain/Payment.ts). */
export class PaymentId extends ValueObject<PaymentIdProps> {
  private constructor(props: PaymentIdProps) {
    super(props);
  }

  static create(value: string): Result<PaymentId, InvalidPaymentIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidPaymentIdError(value));
    }
    return Result.success(new PaymentId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
