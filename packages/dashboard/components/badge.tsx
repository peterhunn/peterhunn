"use client";

interface BadgeProps {
  variant: "green" | "red" | "grey";
  children: React.ReactNode;
}

const variantClasses = {
  green: "bg-green-100 text-green-700",
  red: "bg-red-100 text-red-700",
  grey: "bg-gray-100 text-gray-600",
};

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${variantClasses[variant]}`}>
      {children}
    </span>
  );
}
