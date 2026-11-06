import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Loads deployment-owned adapters without embedding provider credentials or
 * choosing a hosting/KMS provider in the application package.
 * The module must export createApplicationDependencies({ environment }).
 */
export const loadApplicationDependencies = async (
  environment,
  { modulePath = environment?.compositionModule, importer = (url) => import(url) } = {},
) => {
  if (environment?.nodeEnv !== "production") return {};
  if (typeof modulePath !== "string" || modulePath.trim() === "") {
    throw new Error("Production application composition is not configured");
  }

  const resolvedPath = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  let loaded;
  try {
    loaded = await importer(pathToFileURL(resolvedPath).href);
  } catch {
    throw new Error("Production application composition is unavailable");
  }
  if (typeof loaded?.createApplicationDependencies !== "function") {
    throw new Error("Production application composition is invalid");
  }

  let dependencies;
  try {
    dependencies = await loaded.createApplicationDependencies({ environment });
  } catch {
    throw new Error("Production application adapters are unavailable");
  }
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("Production application composition is invalid");
  }
  if (Object.hasOwn(dependencies, "mfaService")) {
    throw new Error("Production MFA service must be composed with the validated KMS adapter");
  }
  if (!dependencies.mfaEncryptionProvider || dependencies.mfaEncryptionProvider.kind !== "kms-envelope") {
    throw new Error("An approved production KMS adapter is required");
  }
  if (dependencies.rateLimitStore && (dependencies.rateLimitStore.shared !== true
    || typeof dependencies.rateLimitStore.increment !== "function"
    || typeof dependencies.rateLimitStore.healthCheck !== "function")) {
    throw new Error("Production rate-limit storage must be shared and healthy-capable");
  }
  return dependencies;
};
