"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@auth0/nextjs-auth0/client";
import { TenantProvider } from "@/lib/tenant-context";
import { ThemeToggle } from "@/components/theme-toggle";

const navItems = [
  { href: "/agreements", label: "Agreements" },
  { href: "/templates", label: "Templates" },
  { href: "/requirements", label: "Requirements" },
  { href: "/keys", label: "API Keys" },
  { href: "/webhooks", label: "Webhooks" },
  { href: "/pending-contracts", label: "Pending" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useUser();

  return (
    <TenantProvider>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex">
        {/* Sidebar */}
        <aside className="w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
          <div className="px-4 py-5 border-b border-gray-200 dark:border-gray-700">
            <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">x490 Dashboard</span>
            {user?.name && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{user.name}</p>
            )}
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
                      ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="px-2 py-4 border-t border-gray-200 dark:border-gray-700 space-y-1">
            <ThemeToggle />
            <a
              href="/api/auth/logout"
              className="block px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100 transition-colors"
            >
              Sign out
            </a>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto dark:bg-gray-900 dark:text-gray-100">{children}</main>
      </div>
    </TenantProvider>
  );
}
