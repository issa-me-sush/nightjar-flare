"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav({ right }: { right?: React.ReactNode }) {
  const path = usePathname();
  const on = (href: string) => (path === href ? "on" : "");

  return (
    <div className="topbar">
      <div className="inner">
        <div className="row gap24">
          <Link href="/" className="brand">
            <b>Nightjar</b>
            <span>FXRP dark pool</span>
          </Link>
          <nav className="navlinks">
            <Link href="/trade" className={on("/trade")}>Trade</Link>
            <Link href="/depth" className={on("/depth")}>Depth</Link>
            <Link href="/proof" className={on("/proof")}>Proof</Link>
            <a href="https://github.com/issa-me-sush/nightjar-flare" target="_blank" rel="noreferrer">
              Code
            </a>
          </nav>
        </div>
        <div className="row gap12">{right}</div>
      </div>
    </div>
  );
}
