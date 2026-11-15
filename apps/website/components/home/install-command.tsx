"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MANAGERS = [
  { id: "pnpm", command: "pnpm add renderify" },
  { id: "npm", command: "npm install renderify" },
  { id: "yarn", command: "yarn add renderify" },
  { id: "bun", command: "bun add renderify" },
] as const;

type ManagerId = (typeof MANAGERS)[number]["id"];

export function InstallCommand() {
  const [manager, setManager] = useState<ManagerId>("pnpm");
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const command =
    MANAGERS.find((candidate) => candidate.id === manager)?.command ??
    MANAGERS[0].command;

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="install-command">
      <div
        aria-label="Package manager"
        className="install-command-tabs"
        role="tablist"
      >
        {MANAGERS.map((candidate) => (
          <button
            aria-selected={candidate.id === manager}
            key={candidate.id}
            onClick={() => setManager(candidate.id)}
            role="tab"
            type="button"
          >
            {candidate.id}
          </button>
        ))}
      </div>
      <div className="install-command-line">
        <code>
          <span aria-hidden="true" className="install-command-prompt">
            $
          </span>
          {command}
        </code>
        <button
          aria-label={copied ? "Copied" : "Copy install command"}
          className="install-command-copy"
          onClick={() => void copy()}
          type="button"
        >
          {copied ? (
            <Check aria-hidden="true" size={15} />
          ) : (
            <Copy aria-hidden="true" size={15} />
          )}
        </button>
      </div>
    </div>
  );
}
