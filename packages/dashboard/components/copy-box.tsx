"use client";

import { useState } from "react";

interface CopyBoxProps {
  value: string;
  label?: string;
}

export function CopyBox({ value, label }: CopyBoxProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      {label && <p className="text-sm font-medium text-gray-700 mb-1">{label}</p>}
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={value}
          className="flex-1 font-mono text-xs border border-gray-300 rounded-md px-3 py-2 bg-gray-50 focus:outline-none"
        />
        <button
          onClick={handleCopy}
          className="px-3 py-2 text-xs font-medium bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-md transition-colors whitespace-nowrap"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
