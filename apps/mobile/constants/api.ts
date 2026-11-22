/**
 * Where the Muse API runs. Defaults to http://localhost:8080 (works in the web
 * build and the iOS simulator). On a physical phone or the Android emulator,
 * set EXPO_PUBLIC_API_URL in apps/mobile/.env, e.g. http://192.168.1.20:8080
 * (your computer's LAN address) or http://10.0.2.2:8080 (Android emulator).
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
