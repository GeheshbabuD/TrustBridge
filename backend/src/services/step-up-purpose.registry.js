// Purposes authorize only a recent MFA proof. They never replace role,
// ownership, consent, or operation-specific authorization checks.
const purposeDefinitions = {
  MFA_RECOVERY_CODES_REGENERATE: Object.freeze({
    resourceType: "USER",
    resourceRequired: true,
    allowedRoles: Object.freeze(["USER", "ADMIN"]),
    maxAgeSeconds: 300,
    additionalAuthorizationRequired: true,
    oneTime: true,
  }),
};

export const STEP_UP_PURPOSES = Object.freeze(purposeDefinitions);

export const resolveStepUpPurpose = (registry, purpose) => {
  if (!registry || typeof purpose !== "string") return null;
  const definition = registry instanceof Map ? registry.get(purpose) : registry[purpose];
  if (!definition || !Array.isArray(definition.allowedRoles) || !Number.isInteger(definition.maxAgeSeconds)) return null;
  return definition;
};

export const createStepUpPurposeRegistry = (entries) => {
  const registry = Object.create(null);
  for (const [purpose, definition] of Object.entries(entries ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(purpose)
      || !definition || !Array.isArray(definition.allowedRoles) || definition.allowedRoles.length === 0
      || definition.allowedRoles.some((role) => !["USER", "ADMIN"].includes(role))
      || new Set(definition.allowedRoles).size !== definition.allowedRoles.length
      || !Number.isInteger(definition.maxAgeSeconds) || definition.maxAgeSeconds < 1 || definition.maxAgeSeconds > 3600
      || typeof definition.resourceType !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(definition.resourceType)
      || typeof definition.resourceRequired !== "boolean"
      || typeof definition.additionalAuthorizationRequired !== "boolean"
      || typeof definition.oneTime !== "boolean"
      || typeof definition.oneTime !== "boolean") {
      throw new TypeError("Invalid step-up purpose definition");
    }
    registry[purpose] = Object.freeze({ ...definition, allowedRoles: Object.freeze([...definition.allowedRoles]) });
  }
  return Object.freeze(registry);
};

export const DEFAULT_STEP_UP_PURPOSES = createStepUpPurposeRegistry(purposeDefinitions);
