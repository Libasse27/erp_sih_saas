import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidFacilitySettingsIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de configuration d'etablissement invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidFacilitySettingsIdError';
  }
}

interface FacilitySettingsIdProps {
  readonly value: string;
}

/** Identifiant de `FacilitySettings` — calque strict de `NotificationId`/`RefreshTokenId` (voir ces fichiers). */
export class FacilitySettingsId extends ValueObject<FacilitySettingsIdProps> {
  private constructor(props: FacilitySettingsIdProps) {
    super(props);
  }

  static create(value: string): Result<FacilitySettingsId, InvalidFacilitySettingsIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidFacilitySettingsIdError(value));
    }
    return Result.success(new FacilitySettingsId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
