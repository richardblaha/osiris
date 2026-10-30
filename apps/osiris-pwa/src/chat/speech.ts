import { useSyncExternalStore } from "react";
import { api } from "../api.ts";
import { currentLocale } from "../i18n.ts";

/**
 * Answers read aloud (Piper, through the gateway's /api/tts): one at a time, a new one stops the last. Whether the
 * chat reads each answer as it finishes is the user's choice in this browser.
 */
const KEY = "osiris.speak";
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();
let player: HTMLAudioElement | undefined;

export const speechEnabled = () => enabled;
export function setSpeechEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Without storage the choice lasts as long as the page.
  }
  if (!on) stopSpeaking();
  listeners.forEach((l) => l());
}
/** Whether answers are read aloud, as React state. */
export const useSpeechEnabled = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => enabled,
  );

export function stopSpeaking() {
  player?.pause();
  player = undefined;
}

/** Reads a text aloud; a failure leaves the written answer as it is. */
export async function speak(text: string) {
  if (!text.trim()) return;
  try {
    const url = URL.createObjectURL(await api.tts(text, currentLocale()));
    stopSpeaking();
    const audio = new Audio(url);
    player = audio;
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    // Speech is a courtesy.
  }
}
