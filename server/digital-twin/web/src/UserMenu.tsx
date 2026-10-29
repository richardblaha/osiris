import { t } from "i18next";
import { useEffect, useRef, useState } from "react";
import { accountUrl, authOff, logout } from "./auth.ts";
import { applyLanguageSetting, currentLocale } from "./i18n.ts";

/** Who is signed in, as the avatar shows them. */
export interface Profile {
  name?: string;
  email?: string;
  picture?: string;
}

/** Up to two initials of a name (or the email's first letter). */
const initials = (user?: Profile) =>
  (user?.name ?? user?.email ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * The user as an avatar (their picture, else initials); a click opens the menu: who they are, their account at the
 * identity provider, the language and signing out. A click elsewhere or Escape closes it.
 */
export function UserMenu({ user }: { user?: Profile }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    // Captured on the document, so it runs (and takes the Escape) before the app's own handler.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), setOpen(false));
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label = user?.name ?? user?.email ?? t("common:user");
  return (
    <div ref={box} className="relative">
      <button type="button" className="avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t("common:userMenu", { name: label })} title={label}>
        {user?.picture && !broken ? <img src={user.picture} alt="" onError={() => setBroken(true)} /> : <span>{initials(user)}</span>}
      </button>
      {open && (
        <div className="menu-popup end-0 w-64" role="menu">
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-sm font-semibold">{user?.name ?? "—"}</p>
            {user?.email && <p className="truncate text-xs text-fg-secondary">{user.email}</p>}
          </div>
          {accountUrl && (
            <a role="menuitem" href={accountUrl} target="_blank" rel="noopener" className="list-row block px-3 py-1.5 text-sm">
              {t("common:account")} ↗
            </a>
          )}
          <button role="menuitem" type="button" className="list-row block w-full px-3 py-1.5 text-start text-sm" onClick={() => applyLanguageSetting(currentLocale() === "cs" ? "en" : "cs")}>
            {currentLocale() === "cs" ? "English" : "Česky"}
          </button>
          {!authOff && (
            <button role="menuitem" type="button" className="list-row block w-full border-t border-line px-3 py-1.5 text-start text-sm" onClick={() => void logout()}>
              {t("common:signOut")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
