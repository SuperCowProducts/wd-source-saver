// sites + settings live in chrome.storage.local (sync's 8 KB-per-item quota is too small); old sync data is migrated on read
import { DEFAULTS } from "./lib.js";

export async function getSites() {
  const l = await chrome.storage.local.get("sites");
  if (l.sites) return l.sites;
  return (await chrome.storage.sync.get("sites")).sites || [];
}
export async function getSettings() {
  let st = (await chrome.storage.local.get("settings")).settings;
  if (!st) st = (await chrome.storage.sync.get("settings")).settings || {};
  return { ...DEFAULTS, ...st };
}
export const saveAll = (sites, settings) => chrome.storage.local.set({ sites, settings });
