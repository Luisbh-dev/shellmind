import path from 'path';

// Must equal build.appId in package.json: electron-builder gives the NSIS
// shortcuts this AppUserModelID, and Windows only groups the running window
// with a pinned shortcut (and attributes its notifications to the app) when
// the process uses the same one.
export const APP_USER_MODEL_ID = 'com.shellmind.app';

// The data folder of a development run (`npm run electron:dev`). Both builds
// are named "shellmind", so they would share %APPDATA%\shellmind and its
// single-instance lock: whichever started second quit at once, and a dev
// window that quits ends the whole dev session. The installed app keeps the
// default folder, where its existing data is.
export function devUserDataDir(appData: string): string {
    return path.join(appData, 'shellmind-dev');
}
