// Small, shadcn-flavoured primitives. Kept local so the app has no runtime UI dependency.

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/format";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent-solid text-accent-fg hover:brightness-110 active:brightness-95 disabled:bg-surface-3 disabled:text-fg-3",
  secondary: "bg-surface-3 text-fg hover:brightness-105 active:brightness-95 disabled:text-fg-3",
  outline: "border border-line bg-surface-2 text-fg hover:bg-surface-3 disabled:text-fg-3",
  ghost: "bg-transparent text-fg-2 hover:bg-surface-3 hover:text-fg",
  danger: "bg-danger/12 text-danger hover:bg-danger/20 disabled:bg-surface-3 disabled:text-fg-3",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1",
  md: "h-8 px-3 text-[13px] gap-1.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", icon, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-medium transition",
        "disabled:cursor-not-allowed disabled:opacity-70",
        "focus-visible:outline-2 focus-visible:outline-accent",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export function IconButton({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-2 transition",
        "hover:bg-surface-3 hover:text-fg disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-fg",
        "placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export function Card({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <div className={cn("rounded-xl border border-line bg-surface-2 p-3", className)} title={title}>
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger" | "accent"; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface-3 text-fg-2",
    ok: "bg-ok/15 text-ok-text",
    warn: "bg-warn/15 text-warn",
    danger: "bg-danger/15 text-danger-text",
    accent: "bg-accent/15 text-accent-text",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tones[tone])}>
      {children}
    </span>
  );
}
