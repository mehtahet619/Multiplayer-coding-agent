/**
 * Validate the owner/repository form accepted by the session API.
 * This intentionally mirrors GitHub's common owner/repository slug characters.
 */
export function isValidRepositorySlug(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
