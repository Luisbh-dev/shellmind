import type en from '../en/settings';

const es: typeof en = {
    title: 'Ajustes',
    sectionsLabel: 'Secciones de ajustes',
    sections: {
        general: 'General',
        appearance: 'Apariencia',
        ai: 'IA',
        keychain: 'Llavero',
        data: 'Datos',
        about: 'Acerca de'
    },
    retry: 'Reintentar',
    language: {
        heading: 'Idioma',
        description: 'Idioma de la interfaz.',
        system: 'Predeterminado del sistema ({language})'
    },
    shortcuts: {
        heading: 'Atajos de teclado'
    },
    ai: {
        heading: 'Proveedores de IA',
        checking: 'Comprobando proveedores...',
        statusUnavailable: 'No se pudo comprobar la configuración de IA',
        notConfigured: 'Sin configurar',
        configured: 'Configurado ({source})',
        proxyManaged: 'Gestionado por el proxy',
        proxyWithKey: 'Proxy + tu clave ({source})',
        source: {
            env: 'Variables de entorno',
            db: 'Base de datos'
        },
        minimaxViaProxy: 'Las peticiones a MiniMax pasan por el proxy de ShellMind antes de llegar a MiniMax, tal y como se indica en el {legal}. Tus mensajes y el contexto del terminal que compartas pasan por él.',
        minimaxDirect: 'Con tu propia clave, las peticiones a MiniMax van directamente del backend de ShellMind a MiniMax; no se usa el proxy de ShellMind.',
        legalLink: 'aviso legal',
        geminiDisclosure: 'Las peticiones a Gemini van directamente del backend de ShellMind a Google.',
        minimaxClientKeyAllowed: 'Si quieres, puedes añadir tu propia clave de MiniMax.',
        minimaxClientKeyDirect: 'Añade tu propia clave de MiniMax para que las peticiones vayan directamente a MiniMax.',
        minimaxClientKeyDisabled: 'La política del proxy no permite usar tu propia clave de MiniMax.',
        lockedByEnv: 'Se gestiona con variables de entorno. No se puede cambiar aquí.',
        savingDisabled: 'Con esta configuración no se pueden guardar claves de {provider} desde la aplicación.',
        help: {
            gemini: 'Consigue tu clave en Google AI Studio.',
            minimax: 'Opcional: usa tu propia clave.'
        },
        openPortal: 'Abrir el portal',
        keyLabel: 'Clave API de {provider}',
        keyPlaceholderSaved: 'Guardada. Escribe una nueva para sustituirla',
        delete: 'Eliminar',
        saveKey: 'Guardar clave',
        updateKey: 'Actualizar clave',
        saved: 'Clave de {provider} guardada',
        saveFailed: 'No se pudo guardar la clave',
        saveError: 'Error al guardar la clave',
        deleteDialog: {
            title: 'Eliminar clave API',
            message: '¿Eliminar de la aplicación la clave API guardada de {provider}? Las claves definidas en variables de entorno no se ven afectadas.',
            confirm: 'Eliminar clave'
        },
        deleted: 'Clave de {provider} eliminada',
        deleteFailed: 'No se pudo eliminar la clave',
        deleteError: 'Error al eliminar la clave'
    },
    data: {
        encryptedTitle: 'Las credenciales se guardan cifradas',
        encryptedBody: 'Las contraseñas, claves privadas, frases de paso, secretos de S3 y claves API se guardan cifrados (AES-256-GCM). La clave de cifrado está junto a la base de datos y, en la aplicación de escritorio, protegida por el llavero del sistema operativo. Nunca salen del backend ni se exportan.'
    },
    about: {
        version: 'Versión {version}',
        backendVersion: 'Versión del backend {version}',
        description: 'El espacio de trabajo autoalojado para sysadmins y DevOps: terminales SSH, archivos, operaciones, salud de la flota, Escritorio remoto y asistente de IA.',
        license: 'Código abierto con licencia MIT.',
        source: 'Código fuente en GitHub'
    }
};

export default es;
