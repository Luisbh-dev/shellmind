// The version of this build, taken from package.json when it is bundled (only
// the field itself ends up in the bundle).
import { version } from '../../package.json';

export const APP_VERSION: string = version;

// "0.4.2" -> "0.4": the release a version belongs to ("What's new in 0.4").
export function releaseOf(value: string): string {
    const [major = '0', minor = '0'] = value.split(/[.+-]/);
    return `${major}.${minor}`;
}

// Orders two releases numerically ("0.9" before "0.10"): negative when `a`
// comes first, 0 when they are the same.
export function compareReleases(a: string, b: string): number {
    const [majorA, minorA] = releaseOf(a).split('.').map(Number);
    const [majorB, minorB] = releaseOf(b).split('.').map(Number);
    return majorA - majorB || minorA - minorB;
}
