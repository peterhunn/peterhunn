"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const { user, isLoading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/agreements");
    }
  }, [user, isLoading, router]);

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-sm p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">x490 Dashboard</h1>
        <p className="text-sm text-gray-500 mb-6">Sign in to manage your contracts and agreements</p>

        <a
          href="/api/auth/login"
          className="block w-full text-center bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md px-4 py-2 text-sm transition-colors"
        >
          Sign in with Auth0
        </a>
      </div>
    </div>
  );
}
