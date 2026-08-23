import { Result } from '../Result.js';
import { ValueObject } from '../ValueObject.js';

export class InvalidPhoneNumberError extends Error {
  constructor(value: string) {
    super(`Numero de telephone invalide : "${value}" (attendu : +221 suivi de 9 chiffres).`);
    this.name = 'InvalidPhoneNumberError';
  }
}

interface PhoneNumberProps {
  readonly e164: string;
}

const SENEGAL_MOBILE_PATTERN = /^\+221[0-9]{9}$/;

/**
 * Numero de telephone senegalais, format E.164 (+221 + 9 chiffres). Portee volontairement
 * limitee au Senegal en V1, coherent avec la priorite initiale du cahier des charges —
 * l'extension a d'autres indicatifs se fera par un ADR, pas par un assouplissement
 * silencieux de ce pattern.
 */
export class PhoneNumber extends ValueObject<PhoneNumberProps> {
  private constructor(props: PhoneNumberProps) {
    super(props);
  }

  static create(value: string): Result<PhoneNumber, InvalidPhoneNumberError> {
    const normalized = value.replace(/[\s.-]/g, '');
    if (!SENEGAL_MOBILE_PATTERN.test(normalized)) {
      return Result.failure(new InvalidPhoneNumberError(value));
    }
    return Result.success(new PhoneNumber({ e164: normalized }));
  }

  toE164(): string {
    return this.props.e164;
  }
}
