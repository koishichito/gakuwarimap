import { Link, useLocation } from "wouter";
import { MapPin, List, PlusCircle, Search, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/agent", label: "AI検索", icon: Bot },
  { href: "/spots", label: "一覧", icon: List },
  { href: "/search", label: "検索", icon: Search },
  { href: "/submit", label: "投稿", icon: PlusCircle },
];

export function Navbar() {
  const [location] = useLocation();

  return (
    <>
      {/* Desktop top nav */}
      <header className="hidden md:block sticky top-0 z-50 bg-background/90 backdrop-blur-md border-b-2 border-foreground/10">
        <div className="container flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center border-2 border-foreground shadow-[2px_2px_0px_oklch(0.15_0.01_0)]">
              <MapPin className="text-primary-foreground" size={20} />
            </div>
            <span className="text-xl font-extrabold tracking-tight uppercase">
              学割マップ
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href}>
                  <span className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-[2px_2px_0px_oklch(0.15_0.01_0)] border-2 border-foreground"
                      : "hover:bg-muted text-foreground/70 hover:text-foreground"
                  )}>
                    <item.icon size={16} />
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-md border-t-2 border-foreground/10 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <span className={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg transition-all",
                  isActive ? "text-primary" : "text-foreground/50"
                )}>
                  <item.icon size={22} strokeWidth={isActive ? 2.5 : 2} />
                  <span className="text-[10px] font-semibold">{item.label}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
