"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getAuth } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const auth = getAuth();
    if (auth) {
      router.replace("/dashboard/agreements");
    } else {
      router.replace("/dashboard/login");
    }
  }, [router]);

  return null;
}
