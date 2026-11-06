/** Default evidence storage boundary. A private object-storage provider must be
 * explicitly injected by deployment; there is no public/local disk fallback. */
export const createUnavailableEvidenceStorage = () => Object.freeze({
  async putObject() { throw new Error("EVIDENCE_STORAGE_UNAVAILABLE"); },
  async getObject() { throw new Error("EVIDENCE_STORAGE_UNAVAILABLE"); },
  async deleteObject() { throw new Error("EVIDENCE_STORAGE_UNAVAILABLE"); },
});
