import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names and resolve Tailwind conflicts.
 * `cn("px-2", cond && "px-4")` -> "px-4"
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
