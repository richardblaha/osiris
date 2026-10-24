// The connection page wears the PWA's own palette and typeface: copied from the PWA before every build.
import { copyFileSync, mkdirSync } from "node:fs";
const pwa = new URL("../../osiris-pwa/src/", import.meta.url);
const page = new URL("../src/", import.meta.url);
mkdirSync(new URL("fonts/", page), { recursive: true });
copyFileSync(new URL("theme.css", pwa), new URL("theme.css", page));
copyFileSync(new URL("fonts/FiraCode-VF.woff2", pwa), new URL("fonts/FiraCode-VF.woff2", page));
copyFileSync(new URL("../public/logo.svg", pwa), new URL("logo.svg", page));
