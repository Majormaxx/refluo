"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
}

// Primary: checked routinely (Timelock especially — a 24h-delayed
// proposal is something you deliberately check back on). Secondary:
// occasional lookups; visiting them daily would itself suggest something's
// wrong. The visual weight difference is the point, not just the words.
const PRIMARY: NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/timelock", label: "Timelock" },
  { href: "/incidents", label: "Incidents" },
];

const SECONDARY: NavItem[] = [
  { href: "/reference", label: "Reference" },
  { href: "/settings", label: "Settings" },
];

function NavLink({ href, label, muted }: NavItem & { muted?: boolean }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : muted
            ? "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            : "text-foreground hover:bg-accent",
      )}
    >
      {label}
    </Link>
  );
}

export function Nav() {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
      <div className="flex flex-wrap items-center gap-1">
        {PRIMARY.map((item) => (
          <NavLink key={item.href} {...item} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {SECONDARY.map((item) => (
          <NavLink key={item.href} {...item} muted />
        ))}
      </div>
    </nav>
  );
}
