-- Decouple TOTP anti-replay tracking of the login CHALLENGE from that of the enrollment
-- CONFIRMATION (independent security review of Phase 0 step 12/13, finding AC-1) : without this
-- column, confirming enrollment then immediately logging in within the same 30s TOTP window was
-- wrongly rejected as "code already used" -- confirmEnrollment() and registerSuccessfulChallenge()
-- were sharing the single last_accepted_time_step column.
ALTER TABLE "platform"."MfaEnrollment" ADD COLUMN "last_accepted_challenge_time_step" INTEGER;

-- Backfill (independent security review, AC-C): without this, every enrollment that existed
-- before this migration starts with NULL, so the very next login challenge for that account
-- would accept ANY time step -- including one already consumed before the migration ran. Seeding
-- it from the old shared counter reproduces the exact anti-replay floor that was in effect a
-- moment ago, for existing rows only (new rows keep the NULL default from MfaEnrollment.start()).
UPDATE "platform"."MfaEnrollment"
   SET "last_accepted_challenge_time_step" = "last_accepted_time_step"
 WHERE "last_accepted_challenge_time_step" IS NULL;
