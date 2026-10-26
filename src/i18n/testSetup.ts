// Vitest setup file (vitest.config.ts), not part of the app. The app loads a
// language when it is first shown (catalog.ts); tests switch languages
// synchronously (setLanguage('es')) and read the catalog directly, so every
// language is loaded before a test file runs.
import { LANGUAGES, loadLanguage } from './catalog';

await Promise.all(LANGUAGES.map((language) => loadLanguage(language)));
