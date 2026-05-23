"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — render nothing until mounted on client
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button className="px-3 py-2 rounded-md text-sm font-medium text-gray-600 dark:text-gray-400 transition-colors w-full text-left">
        &nbsp;
      </button>
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="block w-full px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100 transition-colors text-left"
      aria-label="Toggle dark mode"
    >
      {isDark ? "☀ Light mode" : "☾ Dark mode"}
    </button>
  );
}
