declare module "*.css";

/** Vite's glob import, as used here (brand/Logo.tsx): each matching file's text, bundled in. */
interface ImportMeta {
  glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
