import { cn } from "@/lib/utils";
import { FLYAITokenIcon } from "@/icons";

/** FLYAI logo — the shared fly.ai mark used across the site and protocol app. */
export function FlyaiLogo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <img
      src={FLYAITokenIcon}
      alt="FLYAI logo"
      width={size}
      height={size}
      className={cn("object-contain", className)}
    />
  );
}
