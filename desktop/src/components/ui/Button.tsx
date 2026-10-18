import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  // Cream: primary actions (New session, Send).
  primary: "bg-accent text-on-accent hover:bg-[#fff3e2] font-semibold",
  secondary: "bg-surface-high text-text border border-border hover:bg-[#262b33]",
  ghost: "text-muted hover:text-text hover:bg-surface-high",
  danger: "bg-surface-high text-error border border-border hover:bg-[#2a2023]",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-lg",
  md: "h-9 px-3.5 text-[13px] gap-2 rounded-[10px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }>(
  function IconButton({ label, active, className = "", children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
          active ? "bg-surface-high text-text" : "text-muted hover:bg-surface-high hover:text-text"
        } ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-high px-1 font-sans text-[10.5px] text-muted">
      {children}
    </kbd>
  );
}
