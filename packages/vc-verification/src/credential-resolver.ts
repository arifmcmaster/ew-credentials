import { OffChainClaim } from './models';

/**
 * An interface for a credential resolver
 */
export interface CredentialResolver {
  /**
   * Fetches credential belonging to a DID for the provided namespace
   * @param did
   * @param namespace
   * @returns Offchain claim of the holder for the namespace
   */
  getCredential(
    did: string,
    namespace: string
  ): Promise<OffChainClaim | undefined>;
}
