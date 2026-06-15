/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
}
