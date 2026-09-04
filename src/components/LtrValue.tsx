import type { ReactNode } from "react";

type LtrValueProps = {
  children: ReactNode;
  className?: string;
};

export function LtrValue({ children, className = "" }: LtrValueProps) {
  return (
    <span
      dir="ltr"
      className={`inline-block ${className}`.trim()}
      style={{ unicodeBidi: "isolate" }}
    >
      {children}
    </span>
  );
}
