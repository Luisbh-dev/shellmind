import type en from '../en/appearance';

const es: typeof en = {
    interface: 'Interfaz',
    terminal: 'Terminal',
    theme: {
        label: 'Tema',
        hint: '«Sistema» sigue a tu sistema operativo (ahora: {current}).',
        system: 'Sistema',
        light: 'Claro',
        dark: 'Oscuro'
    },
    accent: {
        label: 'Color de acento',
        hint: 'Botones, enlaces, selecciones y el cursor del terminal.',
        teal: 'Turquesa',
        blue: 'Azul',
        violet: 'Violeta',
        amber: 'Ámbar',
        fuchsia: 'Fucsia',
        emerald: 'Esmeralda'
    },
    density: {
        label: 'Densidad',
        hint: 'Compacta muestra más filas en pantalla.',
        comfortable: 'Cómoda',
        compact: 'Compacta'
    },
    terminalTheme: {
        label: 'Esquema de colores',
        auto: 'Según el tema',
        autoHint: 'ShellMind Dark o Light, según el tema de la app'
    },
    fontSize: {
        label: 'Tamaño de letra',
        value: '{size} px',
        smaller: 'Letra más pequeña',
        larger: 'Letra más grande'
    },
    cursor: {
        label: 'Cursor',
        block: 'Bloque',
        bar: 'Barra',
        underline: 'Subrayado',
        blink: 'Cursor parpadeante'
    },
    screenReader: {
        label: 'Compatibilidad con lectores de pantalla en el terminal',
        hint: 'Expone la salida del terminal a NVDA, JAWS o VoiceOver, línea a línea. Usa más memoria; actívalo solo si usas un lector de pantalla.'
    },
    preview: 'Vista previa',
    motion: 'Las animaciones siguen el ajuste «reducir movimiento» de tu sistema.',
    reset: 'Restablecer apariencia',
    resetDone: 'Apariencia restablecida a los valores predeterminados'
};

export default es;
