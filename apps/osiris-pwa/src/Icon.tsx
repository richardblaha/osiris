import { MATERIAL_ICONS, MATERIAL_VIEWBOX, type MaterialIcon } from "@osiris/shared/material-icons.ts";

export type { MaterialIcon };

/**
 * A Material Symbols icon (Outlined) in the text's colour. Decorative unless it has a `label` (an icon-only button
 * names itself with aria-label instead).
 */
export function Icon({ name, className = "h-5 w-5", label }: { name: MaterialIcon; className?: string; label?: string }) {
  return (
    <svg viewBox={MATERIAL_VIEWBOX} fill="currentColor" className={`inline-block shrink-0 ${className}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={MATERIAL_ICONS[name]} />
    </svg>
  );
}
