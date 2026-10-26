import { LEGAL_AI_DATA_URL } from '@/lib/links';
import { cn } from '@/lib/cn';

// Link to the AI data section of the legal page; opens outside the app (the
// Electron shell hands https links to the system browser).
export function LegalLink({ label, className }: { label: string; className?: string }) {
    return (
        <a
            href={LEGAL_AI_DATA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('font-medium underline underline-offset-2 hover:no-underline focus-ring rounded-sm', className)}
        >
            {label}
        </a>
    );
}
