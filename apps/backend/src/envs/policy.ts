// Network policy access for the sim driver: the shared engine in src/policy/ (same module the VM driver uses).

import type { NetworkMode } from "@terrarium/shared";
import { checkRequest, isPublicIp, REGISTRY_HOSTS } from "../policy/index.ts";

export interface PolicyModule {
  checkRequest(mode: NetworkMode, req: { method: string; url: string; resolvedIps?: string[] }): { allow: boolean; reason: string };
  REGISTRY_HOSTS: readonly string[];
  isPublicIp(ip: string): boolean;
}

export const policy: PolicyModule = { checkRequest, isPublicIp, REGISTRY_HOSTS };
