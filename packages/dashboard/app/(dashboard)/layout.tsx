"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { getAuth, clearAuth } from "@/lib/auth";

const navItems = [
  { href: "/dashboard/agreements", label: "Agreements" },
  { href: "/dashboard/keys", label: "API Keys" },
  { href: "/dashboard/webhooks", label: "Webhooks" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const auth = getAuth();
    if (!auth) {
      router.replace("/dashboard/login");
    }
  }, [router]);

  function handleSignOut() {
    clearAuth();
    router.push("/dashboard/login");
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-200">
          <span className="font-semibold text-gray-900 text-sm">x490 Dashboard</span>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-2 py-4 border-t border-gray-200">
          <button
            onClick={handleSignOut}
            className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
