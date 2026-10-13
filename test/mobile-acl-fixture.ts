import { loadMobileIdentity as nativeIdentity } from "../src/mobile/identity.js";
import { MobileActivationFault, readPrivateMaterial as nativeMaterial } from "../src/mobile/config.js";

function report(error: unknown): never {
  // Vitest omits custom Error fields. Keep the original rejection/assertions while
  // making a real native refusal diagnosable without paths, identity or material.
  if (error instanceof MobileActivationFault && error.aclDiagnostic) console.error("mobile ACL check failed", error.aclDiagnostic);
  throw error;
}
export const loadMobileIdentity = (...args: Parameters<typeof nativeIdentity>): ReturnType<typeof nativeIdentity> => nativeIdentity(...args).catch(report);
export const readPrivateMaterial = (...args: Parameters<typeof nativeMaterial>): ReturnType<typeof nativeMaterial> => nativeMaterial(...args).catch(report);
