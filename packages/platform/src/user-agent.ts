const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/YaBrowser\//, "Yandex"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/Windows/, "Windows"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

export function parseUserAgent(userAgent: string, screen: number): { browser: string; os: string; device: string } {
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? "Other";
  const os = SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? "Other";
  let device = /iPad|Tablet|Android(?!.*Mobile)/.test(userAgent) ? "tablet" : /Mobi|iPhone|iPod|Android/.test(userAgent) ? "mobile" : "desktop";
  // A desktop User-Agent on a phone-sized screen (requested desktop site).
  if (device === "desktop" && screen > 0 && screen < 600) device = "mobile";
  return { browser, os, device };
}

