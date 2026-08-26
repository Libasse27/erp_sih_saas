import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidAuditEntryIdError extends Error {
  constructor(value: string) {
    super(`Identifiant d'entree d'audit invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidAuditEntryIdError';
  }
}

interface AuditEntryIdProps {
  readonly value: string;
}

/** Identifiant de `AuditEntry` — calque strict de `UserAccountId`. */
export class AuditEntryId extends ValueObject<AuditEntryIdProps> {
  private constructor(props: AuditEntryIdProps) {
    super(props);
  }

  static create(value: string): Result<AuditEntryId, InvalidAuditEntryIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidAuditEntryIdError(value));
    }
    return Result.success(new AuditEntryId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
