"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getMe } from "./api";

interface Tenant {
  tenantId: string;
  name: string;
}

const TenantCtx = createContext<Tenant | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<Tenant | null>(null);

  useEffect(() => {
    getMe()
      .then(setTenant)
      .catch(() => {});
  }, []);

  return <TenantCtx.Provider value={tenant}>{children}</TenantCtx.Provider>;
}

export function useTenant(): Tenant | null {
  return useContext(TenantCtx);
}
