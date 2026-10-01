// The design system's web components (public/ds/components.js). React 19 passes these props through as attributes.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type El<P> = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & P;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "pc-bot": El<{ size?: string; hue?: string; shape?: string; mood?: string }>;
      "pc-track": El<{ pct?: string; hue?: string; shape?: string; state?: string }>;
      "pc-loader": El<{ size?: string }>;
      "pc-logo": El<{ size?: string; wordmark?: string }>;
      "pc-effect": El<{ kind?: string }>;
    }
  }
}
