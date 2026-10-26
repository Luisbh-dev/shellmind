// The inline <head> script that puts the saved theme, accent and density on
// <html> before the first paint, in every browser (scripts/themeBoot.ts
// injects it into index.html; the built page's CSP allows it by hash). It
// repeats what readStoredAppearance + applyAppearance do, from the same
// constants; themeBoot.test.ts runs it against them. ES5, no dependencies:
// it runs before any bundle. It also adds the theme-color meta (the desktop
// title bar follows it), which index.html leaves out for that reason.
import {
    ACCENTS, APPEARANCE_STORAGE_KEY, CHROME_COLORS, DEFAULT_APPEARANCE, DENSITIES, THEME_PREFERENCES
} from './model';

export function themeBootScript(): string {
    const json = JSON.stringify;
    return [
        '(function(){',
        'var d=document.documentElement,p=null;',
        `try{p=JSON.parse(localStorage.getItem(${json(APPEARANCE_STORAGE_KEY)}))}catch(e){}`,
        "if(!p||typeof p!=='object')p={};",
        'function pick(v,l,f){return typeof v==="string"&&l.indexOf(v)>=0?v:f}',
        `var t=pick(p.theme,${json(THEME_PREFERENCES)},${json(DEFAULT_APPEARANCE.theme)});`,
        "if(t==='system'){t='dark';try{if(!matchMedia('(prefers-color-scheme: dark)').matches)t='light'}catch(e){}}",
        "d.setAttribute('data-theme',t);",
        `d.setAttribute('data-accent',pick(p.accent,${json(ACCENTS)},${json(DEFAULT_APPEARANCE.accent)}));`,
        `d.setAttribute('data-density',pick(p.density,${json(DENSITIES)},${json(DEFAULT_APPEARANCE.density)}));`,
        'd.style.colorScheme=t;',
        `var m=document.createElement('meta');m.setAttribute('name','theme-color');m.setAttribute('content',${json(CHROME_COLORS)}[t]);`,
        'document.head.appendChild(m);',
        '})();'
    ].join('');
}
