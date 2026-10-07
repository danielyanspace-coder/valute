/**
 * Deposits through a small pool of public addresses (TronLink accounts).
 * An address is lent to one user per request; whatever arrives on it while the
 * request is open (and during the quarantine after it) belongs to that user.
 */

/** How long the user has to send after getting an address. */
export const DEPOSIT_REQUEST_TTL_MS = 15 * 60_000;
/** After a request ends the address is not lent to anyone else for this long: late transfers stay attributable. */
export const DEPOSIT_QUARANTINE_MS = 30 * 60_000;

export type DepositRequestStatus = 'active' | 'paid' | 'cancelled' | 'expired';

/**
 * Why a deposit waits for the operator instead of being credited:
 * aml              the sender is blacklisted or the check could not run
 * unidentified     the address was not lent to anyone at that moment
 * linked_sender    nobody held the address, but this sender wallet already topped up a known account
 * sender_conflict  the address was lent to one user, the sender wallet belongs to another
 */
export type DepositReview = 'aml' | 'unidentified' | 'linked_sender' | 'sender_conflict';

export const DEPOSIT_REVIEW_TEXT: Record<DepositReview, string> = {
  aml: 'AML-проверка',
  unidentified: 'Неопознанный',
  linked_sender: 'Связь с аккаунтом',
  sender_conflict: 'Чужой отправитель',
};

/** A sender wallet seen with this many different users is an exchange hot wallet: it proves nothing. */
export const SHARED_SENDER_USERS = 2;
