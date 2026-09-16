import { cn } from "@/lib/utils";

export function SHITLogo({ className }: { className?: string }) {
  return (
    <img
      src="/pictures/symbient/sym-poop.png"
      alt="SYM Logo"
      className={cn("object-contain", className)}
    />
  );
}
