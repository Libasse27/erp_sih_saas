import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidNotificationIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de notification invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidNotificationIdError';
  }
}

interface NotificationIdProps {
  readonly value: string;
}

/** Identifiant d'une `Notification` — calque strict de `RefreshTokenId` (voir ce fichier). */
export class NotificationId extends ValueObject<NotificationIdProps> {
  private constructor(props: NotificationIdProps) {
    super(props);
  }

  static create(value: string): Result<NotificationId, InvalidNotificationIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidNotificationIdError(value));
    }
    return Result.success(new NotificationId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
